<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { DiscussionTurn } from "@meguribi/core";
import {
  shouldAutoScrollAfterAppend,
  shouldStickToBottom,
  speakerVisual,
} from "../discussion-thread-view.js";
import { buildThread, type ThreadNode } from "../discussion-view.js";

const props = defineProps<{
  turns: DiscussionTurn[];
}>();

interface FlatThreadNode {
  node: ThreadNode;
}

const palette = ["#73d4c2", "#8fb8ff", "#e8c15a", "#d99df0", "#8fdd8f", "#f0a2a2"];
const rootRef = ref<HTMLElement | null>(null);
const highlightedTurnId = ref<string | null>(null);
const elements = new Map<string, HTMLElement>();
let highlightTimer: ReturnType<typeof setTimeout> | undefined;

const flattened = computed<FlatThreadNode[]>(() => {
  const output: FlatThreadNode[] = [];
  const visit = (node: ThreadNode): void => {
    output.push({ node });
    for (const child of node.children) visit(child);
  };
  for (const root of buildThread(props.turns)) visit(root);
  return output;
});

function setTurnElement(turnId: string, element: unknown): void {
  if (element instanceof HTMLElement) elements.set(turnId, element);
  else elements.delete(turnId);
}

function speakerColor(speaker: string): string {
  let hash = 0;
  for (const char of speaker) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return palette[hash % palette.length]!;
}

function visualFor(turn: DiscussionTurn) {
  return speakerVisual(turn.speaker, turn.speakerLabel);
}

function timeLabel(at: string): string {
  const time = at.slice(11, 19);
  return time.length > 0 ? time : at;
}

function nearestScrollContainer(): HTMLElement | null {
  let current = rootRef.value?.parentElement ?? null;
  while (current !== null) {
    const style = window.getComputedStyle(current);
    if (style.overflowY === "auto" || style.overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

async function scrollToLatest(behavior: ScrollBehavior = "smooth"): Promise<void> {
  await nextTick();
  const container = nearestScrollContainer();
  container?.scrollTo({ top: container.scrollHeight, behavior });
}

watch(
  () => props.turns.length,
  (nextCount, previousCount) => {
    const container = nearestScrollContainer();
    const wasAtBottom =
      container === null
        ? true
        : shouldStickToBottom({
            scrollTop: container.scrollTop,
            clientHeight: container.clientHeight,
            scrollHeight: container.scrollHeight,
          });
    if (!shouldAutoScrollAfterAppend({ previousCount, nextCount, wasAtBottom })) return;
    void scrollToLatest(previousCount === 0 ? "auto" : "smooth");
  },
);

onMounted(() => {
  if (props.turns.length > 0) void scrollToLatest("auto");
});

async function focusTurn(turnId: string): Promise<void> {
  highlightedTurnId.value = turnId;
  await nextTick();
  elements.get(turnId)?.scrollIntoView({ behavior: "smooth", block: "center" });
  if (highlightTimer !== undefined) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    if (highlightedTurnId.value === turnId) highlightedTurnId.value = null;
  }, 1800);
}

defineExpose({ focusTurn, scrollToLatest });
</script>

<template>
  <section ref="rootRef" class="discussion-thread" aria-labelledby="discussion-thread-heading">
    <header class="discussion-section-heading">
      <div>
        <h2 id="discussion-thread-heading">会話ログ</h2>
        <span>{{ turns.length }} turn</span>
      </div>
    </header>
    <p v-if="flattened.length === 0" class="discussion-empty">まだ発言はありません</p>
    <ol v-else class="discussion-turns" role="log" aria-live="polite" aria-relevant="additions">
      <li
        v-for="item in flattened"
        :key="item.node.turn.turnId"
        :ref="(element) => setTurnElement(item.node.turn.turnId, element)"
        :class="[
          'discussion-turn',
          visualFor(item.node.turn).kind,
          {
            highlighted: highlightedTurnId === item.node.turn.turnId,
            malformed: item.node.turn.malformed,
            nested: item.node.depth > 0,
          },
        ]"
        :style="{
          '--depth': item.node.depth,
          '--speaker-color': speakerColor(item.node.turn.speaker),
        }"
      >
        <div class="turn-avatar" aria-hidden="true">{{ visualFor(item.node.turn).initials }}</div>
        <div class="turn-body">
          <div class="discussion-turn-meta">
            <strong>{{ item.node.turn.speakerLabel }}</strong>
            <span class="speaker-kind-badge">{{ visualFor(item.node.turn).kindLabel }}</span>
            <time :datetime="item.node.turn.at">{{ timeLabel(item.node.turn.at) }}</time>
            <span class="turn-id">{{ item.node.turn.turnId }}</span>
            <span v-if="item.node.turn.malformed" class="malformed-badge">形式不正</span>
          </div>
          <p>{{ item.node.turn.envelope.message }}</p>
        </div>
      </li>
    </ol>
  </section>
</template>
