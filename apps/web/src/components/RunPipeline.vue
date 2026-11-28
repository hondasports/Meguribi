<script setup lang="ts">
import type { PipelineStep } from "../../server/run-store-api.js";

defineProps<{
  pipeline: PipelineStep[];
}>();

function icon(status: PipelineStep["status"]): string {
  if (status === "completed") return "✓";
  if (status === "running") return "●";
  if (status === "failed") return "✕";
  return "○";
}
</script>

<template>
  <ol class="pipeline" aria-label="Run の工程">
    <template v-for="(step, index) in pipeline" :key="step.stepId">
      <li :class="['pipeline-step', step.status]">
        <span class="pipeline-icon" aria-hidden="true">{{ icon(step.status) }}</span>
        <span class="pipeline-name">{{ step.stepId }}</span>
        <span v-if="step.visit > 1" class="pipeline-visit">×{{ step.visit }}</span>
      </li>
      <li v-if="index < pipeline.length - 1" class="pipeline-connector" aria-hidden="true">─</li>
    </template>
  </ol>
</template>
