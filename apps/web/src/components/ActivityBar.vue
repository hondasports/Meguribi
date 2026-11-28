<script setup lang="ts">
import type { AgentActivity, AgentActivityState } from "@meguribi/core";
import { formatElapsed, stateLabelJa } from "../run-view.js";

defineProps<{
  activities: AgentActivity[];
}>();

function icon(state: AgentActivityState): string {
  if (state === "failed") return "✕";
  if (state === "finished") return "✓";
  if (state === "idle") return "○";
  if (state === "waiting_permission") return "⚠";
  return "●";
}

function elapsed(activity: AgentActivity): string {
  return formatElapsed(Date.now() - Date.parse(activity.since));
}

function stalledLabel(activity: AgentActivity): string {
  return activity.stalled
    ? `  応答なし ${String(Math.floor(activity.stalledForMs / 60000))}分`
    : "";
}
</script>

<template>
  <section class="activity-bar" aria-label="エージェントの活動">
    <span class="activity-label">活動</span>
    <span v-if="activities.length === 0" class="activity-empty"
      >エージェントのイベントはまだありません</span
    >
    <span
      v-for="activity in activities"
      :key="activity.profileId"
      :class="['activity-item', activity.state, { stalled: activity.stalled }]"
    >
      <span class="activity-icon" aria-hidden="true">{{ icon(activity.state) }}</span>
      <b>{{ activity.agentLabel }}</b>
      <span>{{ stateLabelJa(activity.state) }}</span>
      <span v-if="activity.detail" class="activity-detail">“{{ activity.detail }}”</span>
      <span class="activity-elapsed">{{ elapsed(activity) }}{{ stalledLabel(activity) }}</span>
    </span>
  </section>
</template>
