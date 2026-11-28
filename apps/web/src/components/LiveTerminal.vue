<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { TerminalRow } from "../terminal-contract.js";
import {
  countRowsAfterLastSeen,
  filterTerminalRows,
  formatTerminalTime,
  isNearTerminalBottom,
  shouldRestoreBottomOnCollapseChange,
  speakerColorIndex,
  terminalKindVisual,
  terminalProfileOptions,
  terminalScrollBehavior,
  watchTerminalAutoFollow,
} from "../terminal-view.js";

const props = defineProps<{
  rows: readonly TerminalRow[];
  ended: boolean;
}>();

const scrollRef = ref<HTMLElement | null>(null);
const collapsed = ref(false);
const expanded = ref(false);
const selectedProfileId = ref<string | null>(null);
const paused = ref(false);
const frozenRows = ref<TerminalRow[] | null>(null);
const following = ref(true);
const lastSeenRowId = ref<string | null>(null);

const profileOptions = computed(() => terminalProfileOptions(props.rows));
const liveRows = computed(() => filterTerminalRows(props.rows, selectedProfileId.value));
const displayedRows = computed(() =>
  paused.value && frozenRows.value !== null ? frozenRows.value : liveRows.value,
);
const unreadCount = computed(() =>
  following.value && !paused.value
    ? 0
    : countRowsAfterLastSeen(liveRows.value, lastSeenRowId.value),
);
const latestRowId = computed(() => liveRows.value.at(-1)?.id ?? null);
const latestDisplayedRowId = computed(() => displayedRows.value.at(-1)?.id ?? null);

function rowColor(index: number): string {
  const colors = ["#73d4c2", "#8fb8ff", "#e8c15a", "#d99df0", "#8fdd8f", "#f0a2a2"];
  return colors[index % colors.length]!;
}

function colorFor(profileId: string): string {
  return rowColor(speakerColorIndex(profileId));
}

async function scrollToBottom(behavior: ScrollBehavior = "auto"): Promise<void> {
  await nextTick();
  scrollRef.value?.scrollTo({ top: scrollRef.value.scrollHeight, behavior });
  if (!paused.value) lastSeenRowId.value = latestRowId.value;
}

function onScroll(): void {
  if (paused.value) return;
  const element = scrollRef.value;
  if (element === null) return;
  if (
    isNearTerminalBottom({
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    })
  ) {
    following.value = true;
    lastSeenRowId.value = latestRowId.value;
  } else {
    following.value = false;
  }
}

function pauseTerminal(): void {
  if (paused.value) return;
  frozenRows.value = [...liveRows.value];
  lastSeenRowId.value = liveRows.value.at(-1)?.id ?? null;
  paused.value = true;
  following.value = false;
}

function resumeTerminal(): void {
  paused.value = false;
  frozenRows.value = null;
  following.value = true;
  void scrollToBottom("auto");
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function jumpToLatest(): void {
  paused.value = false;
  frozenRows.value = null;
  following.value = true;
  void scrollToBottom(terminalScrollBehavior(prefersReducedMotion()));
}

function toggleCollapsed(): void {
  const wasCollapsed = collapsed.value;
  collapsed.value = !collapsed.value;
  if (shouldRestoreBottomOnCollapseChange(wasCollapsed, collapsed.value)) {
    void scrollToBottom("auto");
  }
}

function selectProfile(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  selectedProfileId.value = value.length > 0 ? value : null;
  paused.value = false;
  frozenRows.value = null;
  following.value = true;
  lastSeenRowId.value = null;
  void scrollToBottom("auto");
}

watchTerminalAutoFollow({
  rows: liveRows,
  paused,
  following,
  follow: () => void scrollToBottom("auto"),
});
</script>

<template>
  <section
    :class="['live-terminal', { collapsed, expanded, paused }]"
    aria-labelledby="live-terminal-title"
  >
    <header class="terminal-header">
      <div class="terminal-title">
        <span class="terminal-dot" aria-hidden="true"></span>
        <h2 id="live-terminal-title">ライブ端末</h2>
        <span v-if="ended" class="terminal-state">終了</span>
        <span v-else class="terminal-state receiving">受信中</span>
      </div>
      <div class="terminal-actions">
        <label class="profile-filter">
          CLI
          <select
            :value="selectedProfileId ?? ''"
            :disabled="profileOptions.length === 0"
            @change="selectProfile"
          >
            <option value="">全員</option>
            <option v-for="profile in profileOptions" :key="profile.id" :value="profile.id">
              {{ profile.label }}
            </option>
          </select>
        </label>
        <button
          type="button"
          class="terminal-tool"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? "コンパクト" : "拡大" }}
        </button>
        <button
          type="button"
          class="terminal-tool"
          :aria-expanded="!collapsed"
          @click="toggleCollapsed"
        >
          {{ collapsed ? "開く" : "折り畳む" }}
        </button>
        <button v-if="!paused" type="button" class="terminal-tool pause" @click="pauseTerminal">
          一時停止
        </button>
        <button v-else type="button" class="terminal-tool resume" @click="resumeTerminal">
          最新へ
        </button>
      </div>
    </header>

    <template v-if="!collapsed">
      <div ref="scrollRef" class="terminal-scroll" role="log" aria-live="off" @scroll="onScroll">
        <p v-if="displayedRows.length === 0" class="terminal-empty">端末出力はまだありません</p>
        <ol v-else class="terminal-lines">
          <li
            v-for="row in displayedRows"
            :key="row.id"
            :class="['terminal-line', row.kind, { active: row.active }]"
            :style="{ '--speaker-color': colorFor(row.profileId) }"
          >
            <time :datetime="row.at">{{ formatTerminalTime(row.at) }}</time>
            <span class="speaker">{{ row.label }}</span>
            <span class="kind" role="img" :aria-label="terminalKindVisual(row.kind).label">{{
              terminalKindVisual(row.kind).symbol
            }}</span>
            <span class="text"
              >{{ row.text
              }}<span
                v-if="row.id === latestDisplayedRowId && row.active && !ended"
                class="live-cursor"
                aria-hidden="true"
              ></span
            ></span>
          </li>
        </ol>
      </div>
      <button
        v-if="unreadCount > 0"
        type="button"
        class="new-rows"
        aria-live="polite"
        @click="jumpToLatest"
      >
        新着{{ unreadCount }}行
      </button>
    </template>
  </section>
</template>

<style scoped>
.live-terminal {
  position: relative;
  overflow: hidden;
  border: 1px solid #303638;
  border-radius: 12px;
  background: #080a0b;
  color: #e9efed;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.28);
}

.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 42px;
  border-bottom: 1px solid #202425;
  background: #101213;
  padding: 6px 9px;
}

.terminal-title,
.terminal-actions,
.profile-filter {
  display: flex;
  align-items: center;
  gap: 7px;
}

.terminal-title h2 {
  margin: 0;
  font-size: 0.78rem;
  letter-spacing: 0.04em;
}

.terminal-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #73d4c2;
  box-shadow: 0 0 9px rgba(115, 212, 194, 0.75);
}

.terminal-state {
  border-radius: 999px;
  background: #1a1e1f;
  color: #9aa5a1;
  font-size: 0.64rem;
  padding: 2px 6px;
}

.terminal-state.receiving {
  color: #73d4c2;
}

.terminal-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.profile-filter {
  color: #899390;
  font-size: 0.68rem;
}

.profile-filter select,
.terminal-tool {
  min-height: 28px;
  border: 1px solid #303638;
  border-radius: 7px;
  background: #151819;
  color: #dce3e0;
  font-size: 0.68rem;
  padding: 3px 7px;
}

.terminal-tool {
  cursor: pointer;
}

.terminal-tool:hover {
  border-color: #73d4c2;
}

.terminal-tool.pause {
  color: #e8c15a;
}

.terminal-tool.resume {
  color: #73d4c2;
}

.terminal-scroll {
  max-height: 172px;
  overflow-y: auto;
  padding: 8px 0;
  scroll-behavior: smooth;
}

.expanded .terminal-scroll {
  max-height: min(62vh, 560px);
}

.terminal-empty {
  margin: 18px;
  color: #6f7976;
  font-size: 0.75rem;
  text-align: center;
}

.terminal-lines {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  font:
    11px/1.55 "DM Mono",
    ui-monospace,
    monospace;
}

.terminal-line {
  display: grid;
  grid-template-columns: 58px minmax(82px, max-content) 46px minmax(0, 1fr);
  gap: 7px;
  align-items: baseline;
  min-height: 18px;
  padding: 1px 10px;
}

.terminal-line:hover {
  background: rgba(255, 255, 255, 0.025);
}

.terminal-line time {
  color: #626d6a;
}

.terminal-line .speaker {
  color: var(--speaker-color);
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-line .kind {
  color: #6f7976;
  font-size: 0.62rem;
}

.terminal-line.tool .kind {
  color: #e8c15a;
}

.terminal-line.status .kind {
  color: #8fb8ff;
}

.terminal-line .text {
  color: #dce3e0;
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.live-cursor {
  display: inline-block;
  width: 7px;
  height: 13px;
  margin-left: 3px;
  vertical-align: -2px;
  background: #73d4c2;
  animation: terminal-cursor 900ms steps(2, start) infinite;
}

.new-rows {
  position: absolute;
  right: 12px;
  bottom: 10px;
  min-height: 30px;
  border: 1px solid rgba(115, 212, 194, 0.45);
  border-radius: 999px;
  background: rgba(14, 28, 27, 0.94);
  color: #73d4c2;
  cursor: pointer;
  font-size: 0.7rem;
  font-weight: 800;
  padding: 5px 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.36);
}

.collapsed .terminal-header {
  border-bottom: 0;
}

@keyframes terminal-cursor {
  50% {
    opacity: 0;
  }
}

@media (max-width: 700px) {
  .terminal-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .terminal-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .terminal-line {
    grid-template-columns: 48px minmax(58px, max-content) minmax(0, 1fr);
  }

  .terminal-line .kind {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .terminal-scroll {
    scroll-behavior: auto;
  }

  .live-cursor {
    animation: none;
  }
}
</style>
