<script setup lang="ts">
import { computed, ref } from "vue";
import type { RunSummary } from "../../server/run-store-api.js";
import {
  buildThreadItems,
  filterThreadItems,
  moveThreadFocus,
  type ThreadItem,
} from "../thread-sidebar.js";

/**
 * 左ナビのスレッドサイドバー。
 * - 相談/議論をタイトル・識別子で検索し選択する
 * - 新規相談と、その他機能（ビュー）への移動を提供する
 * - モバイルでは操作完了後に `close` を emit し、親がドロワーを閉じられるようにする
 *
 * データ取得とレイアウト（App 全体・グローバル CSS）は親の責務。
 */
const props = defineProps<{
  runs: RunSummary[];
  selectedRunId: string | null;
  loading: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  select: [runId: string];
  newConsultation: [];
  navigate: [view: "consult" | "commands" | "runs"];
  close: [];
}>();

const query = ref("");
const focusedIndex = ref(0);
const itemRefs = ref<Array<HTMLButtonElement | null>>([]);

const items = computed(() => buildThreadItems(props.runs));
const visibleItems = computed(() => filterThreadItems(items.value, query.value));

function statusIcon(status: string): string {
  if (status === "failed" || status === "timed_out" || status === "cancelled") return "✕";
  if (status === "awaiting_human" || status === "completed") return "✓";
  if (status === "blocked" || status === "interrupted") return "⏸";
  return "●";
}

function selectThread(item: ThreadItem): void {
  emit("select", item.runId);
  // モバイルのドロワーは選択後に閉じる。デスクトップでは親が無視してよい。
  emit("close");
}

function startNewConsultation(): void {
  emit("newConsultation");
  emit("close");
}

function navigateTo(view: "consult" | "commands" | "runs"): void {
  emit("navigate", view);
  emit("close");
}

function onListKeydown(event: KeyboardEvent): void {
  const count = visibleItems.value.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = moveThreadFocus(focusedIndex.value, delta, count);
    if (next >= 0) {
      focusedIndex.value = next;
      itemRefs.value[next]?.focus();
    }
  }
}

function setItemRef(element: Element | null, index: number): void {
  itemRefs.value[index] = element as HTMLButtonElement | null;
}
</script>

<template>
  <aside class="thread-sidebar" aria-label="スレッドナビゲーション">
    <div class="thread-sidebar-top">
      <input
        v-model="query"
        class="thread-search"
        type="search"
        placeholder="タイトル・識別子で検索"
        aria-label="スレッドを検索"
      />
      <button class="thread-new" type="button" @click="startNewConsultation">
        <span aria-hidden="true">＋</span> 新規相談
      </button>
    </div>

    <p v-if="loading && visibleItems.length === 0" class="thread-empty">読み込み中…</p>
    <p v-else-if="error" class="thread-error" role="alert">{{ error }}</p>
    <p v-else-if="items.length === 0" class="thread-empty">相談・議論はまだありません</p>
    <p v-else-if="visibleItems.length === 0" class="thread-empty">
      「{{ query }}」に一致するスレッドはありません
    </p>

    <ul v-else class="thread-list" role="listbox" aria-label="スレッド一覧" @keydown="onListKeydown">
      <li v-for="(item, index) in visibleItems" :key="item.runId" role="presentation">
        <button
          :ref="(element) => setItemRef(element as Element | null, index)"
          :class="[
            'thread-item',
            { selected: selectedRunId === item.runId, focused: focusedIndex === index },
          ]"
          type="button"
          role="option"
          :aria-selected="selectedRunId === item.runId"
          :aria-current="selectedRunId === item.runId ? 'true' : undefined"
          @click="selectThread(item)"
          @focus="focusedIndex = index"
        >
          <span class="thread-item-icon" aria-hidden="true">{{ statusIcon(item.status) }}</span>
          <span class="thread-item-main">
            <b>{{ item.title }}</b>
            <small>{{ item.subtitle }}</small>
          </span>
          <span class="thread-item-status">{{ item.statusLabel }}</span>
        </button>
      </li>
    </ul>

    <nav class="thread-nav" aria-label="その他の機能">
      <div class="thread-nav-label">その他の機能</div>
      <button class="thread-nav-item" type="button" @click="navigateTo('commands')">
        コマンド実行
      </button>
      <button class="thread-nav-item" type="button" @click="navigateTo('runs')">Run 一覧</button>
    </nav>
  </aside>
</template>

<style scoped>
.thread-sidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 12px;
  background: #16181d;
  color: #e6e8ec;
}

.thread-sidebar-top {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.thread-search {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #2c3038;
  border-radius: 8px;
  background: #0f1115;
  color: inherit;
  font-size: 0.9rem;
}

.thread-search:focus-visible {
  outline: 2px solid #4f7cff;
  outline-offset: 1px;
}

.thread-new {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid #2c3038;
  border-radius: 8px;
  background: #1f232b;
  color: inherit;
  font-size: 0.9rem;
  cursor: pointer;
}

.thread-new:hover {
  background: #262b35;
}

.thread-new:focus-visible {
  outline: 2px solid #4f7cff;
  outline-offset: 1px;
}

.thread-empty {
  margin: 8px 4px;
  color: #9aa0ab;
  font-size: 0.85rem;
}

.thread-error {
  margin: 8px 4px;
  color: #ff8a8a;
  font-size: 0.85rem;
}

.thread-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.thread-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.thread-item:hover {
  background: #1f232b;
}

.thread-item:focus-visible {
  outline: 2px solid #4f7cff;
  outline-offset: 1px;
}

.thread-item.selected {
  background: #20242e;
  border-color: #3a4150;
}

.thread-item-icon {
  flex-shrink: 0;
  width: 1.2em;
  text-align: center;
  color: #9aa0ab;
}

.thread-item-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.thread-item-main b {
  font-size: 0.88rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread-item-main small {
  font-size: 0.75rem;
  color: #9aa0ab;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread-item-status {
  flex-shrink: 0;
  font-size: 0.72rem;
  color: #9aa0ab;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid #2c3038;
}

.thread-item.selected .thread-item-status {
  color: #c9d4ff;
  border-color: #4f7cff;
}

.thread-nav {
  border-top: 1px solid #2c3038;
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.thread-nav-label {
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  color: #7c828d;
  padding: 0 4px 4px;
}

.thread-nav-item {
  min-height: 44px;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  text-align: left;
  font-size: 0.88rem;
  cursor: pointer;
}

.thread-nav-item:hover {
  background: #1f232b;
}

.thread-nav-item:focus-visible {
  outline: 2px solid #4f7cff;
  outline-offset: 1px;
}
</style>
