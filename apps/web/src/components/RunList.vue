<script setup lang="ts">
import type { RunSummary } from "../../server/run-store-api.js";

defineProps<{
  runs: RunSummary[];
  selectedRunId: string | null;
  loading: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  select: [runId: string];
}>();

const statusLabels: Record<string, string> = {
  created: "作成済み",
  planning: "計画中",
  planned: "計画済み",
  implementing: "実装中",
  verifying: "検証中",
  reviewing: "レビュー中",
  fixing: "修正中",
  publishing: "公開中",
  awaiting_human: "承認待ち",
  blocked: "停止",
  failed: "失敗",
  cancelled: "中止",
  interrupted: "中断",
  timed_out: "タイムアウト",
  completed: "完了",
};

function statusLabel(status: string): string {
  return statusLabels[status] ?? status;
}

function statusIcon(status: string): string {
  if (status === "failed" || status === "timed_out" || status === "cancelled") return "✕";
  if (status === "awaiting_human" || status === "completed") return "✓";
  if (status === "blocked" || status === "interrupted") return "⏸";
  return "●";
}

function isActive(status: string): boolean {
  return [
    "created",
    "planning",
    "implementing",
    "verifying",
    "reviewing",
    "fixing",
    "publishing",
  ].includes(status);
}
</script>

<template>
  <section class="run-list-panel">
    <div class="eyebrow">RUNS</div>
    <p v-if="loading && runs.length === 0" class="run-list-empty">読み込み中…</p>
    <p v-else-if="error" class="run-list-error">{{ error }}</p>
    <p v-else-if="runs.length === 0" class="run-list-empty">Run はまだありません</p>
    <button
      v-for="run in runs"
      :key="run.runId"
      :class="[
        'run-list-item',
        { selected: selectedRunId === run.runId, active: isActive(run.status) },
      ]"
      type="button"
      @click="emit('select', run.runId)"
    >
      <span class="run-list-icon" aria-hidden="true">{{ statusIcon(run.status) }}</span>
      <span class="run-list-main">
        <b>#{{ run.issueNumber }} {{ statusLabel(run.status) }}</b>
        <small>{{ run.repository }} · {{ run.command }}</small>
      </span>
    </button>
  </section>
</template>
