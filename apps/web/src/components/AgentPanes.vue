<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { PaneState } from "../run-view.js";

const props = defineProps<{
  panes: PaneState[];
  selectedPane: "agents" | "all";
}>();

const emit = defineEmits<{
  "update:selectedPane": [value: "agents" | "all"];
}>();

const paused = ref(false);
const manuallyStopped = ref(new Set<string>());
const elements = new Map<string, HTMLElement>();

function setPaneElement(id: string, element: unknown): void {
  if (element instanceof HTMLElement) elements.set(id, element);
  else elements.delete(id);
}

function atBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 24;
}

function onScroll(id: string, event: Event): void {
  const element = event.currentTarget;
  if (!(element instanceof HTMLElement)) return;
  const next = new Set(manuallyStopped.value);
  if (atBottom(element)) next.delete(id);
  else next.add(id);
  manuallyStopped.value = next;
}

async function scrollPanes(force = false): Promise<void> {
  await nextTick();
  for (const [id, element] of elements) {
    if (!force && (paused.value || manuallyStopped.value.has(id))) continue;
    element.scrollTop = element.scrollHeight;
  }
}

function togglePaused(): void {
  paused.value = !paused.value;
  if (!paused.value) {
    manuallyStopped.value = new Set();
    void scrollPanes(true);
  }
}

watch(
  () => props.panes.map((pane) => `${pane.id}:${pane.text.length}`).join("|"),
  () => void scrollPanes(),
  { flush: "post" },
);

watch(
  () => props.selectedPane,
  () => void scrollPanes(true),
  { flush: "post" },
);
</script>

<template>
  <section class="agent-pane-section">
    <div class="pane-toolbar">
      <div class="pane-tabs" role="tablist" aria-label="ライブログ表示">
        <button
          :class="['pane-tab', { active: selectedPane === 'agents' }]"
          type="button"
          role="tab"
          :aria-selected="selectedPane === 'agents'"
          @click="emit('update:selectedPane', 'agents')"
        >
          エージェント別
        </button>
        <button
          :class="['pane-tab', { active: selectedPane === 'all' }]"
          type="button"
          role="tab"
          :aria-selected="selectedPane === 'all'"
          @click="emit('update:selectedPane', 'all')"
        >
          全体
        </button>
      </div>
      <button class="pause-button" type="button" @click="togglePaused">
        {{ paused ? "自動スクロール再開" : "一時停止" }}
      </button>
    </div>

    <div v-if="selectedPane === 'all'" class="pane-grid single">
      <article
        v-for="pane in panes.filter((item) => item.id === 'all')"
        :key="pane.id"
        class="agent-pane overall"
      >
        <header>
          <b>{{ pane.title }}</b>
          <span>全イベント</span>
        </header>
        <div
          :ref="(element) => setPaneElement(pane.id, element)"
          class="pane-log"
          @scroll="onScroll(pane.id, $event)"
        >
          {{ pane.text }}
        </div>
      </article>
    </div>

    <div v-else class="pane-grid">
      <p v-if="panes.filter((pane) => pane.id !== 'all').length === 0" class="pane-empty">
        エージェントのイベントを待っています
      </p>
      <article
        v-for="pane in panes.filter((item) => item.id !== 'all')"
        :key="pane.id"
        :class="['agent-pane', { active: pane.active, stalled: pane.stalled }]"
      >
        <header>
          <b>{{ pane.title }}</b>
          <span>{{ pane.stateLabel }}</span>
        </header>
        <p v-if="pane.stalled" class="stall-warning">⚠ 応答なし</p>
        <div
          :ref="(element) => setPaneElement(pane.id, element)"
          class="pane-log"
          @scroll="onScroll(pane.id, $event)"
        >
          {{ pane.text }}
        </div>
      </article>
    </div>
  </section>
</template>
