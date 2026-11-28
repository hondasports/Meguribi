<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DiscussionProfile, StartDiscussionInput } from "../consultation-api.js";
import { validateConsultationInput } from "../consultation-api.js";
import { MAX_CONSULTATION_PROMPT_LENGTH } from "../consultation-contract.js";

const props = defineProps<{
  profiles: DiscussionProfile[];
  defaultProfileIds: string[];
  loading: boolean;
  starting: boolean;
  loadError: string | null;
  startError: string | null;
}>();

const emit = defineEmits<{
  start: [input: StartDiscussionInput];
}>();

const prompt = ref("");
const target = ref("");
const selectedIds = ref<string[]>([]);
const validationError = ref<string | null>(null);
let submitInFlight = false;

watch(
  () => props.defaultProfileIds,
  (ids) => {
    if (selectedIds.value.length === 0) selectedIds.value = [...ids];
  },
  { immediate: true },
);

const disabledReason = computed(() => {
  if (props.loading) return "参加エージェントを読み込んでいます";
  if (props.loadError !== null) return "参加エージェントを読み込めません";
  if (props.starting) return "相談を開始しています";
  return validateConsultationInput({ prompt: prompt.value, profileIds: selectedIds.value });
});

function toggle(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((candidate) => candidate !== id)
    : [...selectedIds.value, id];
}

function submit(): void {
  if (submitInFlight || props.starting) return;
  const error = validateConsultationInput({ prompt: prompt.value, profileIds: selectedIds.value });
  validationError.value = error;
  if (error !== null) return;
  submitInFlight = true;
  emit("start", {
    prompt: prompt.value.trim(),
    profileIds: [...selectedIds.value],
    ...(target.value.trim().length > 0 ? { target: target.value.trim() } : {}),
  });
}

watch(
  () => props.starting,
  (starting) => {
    if (!starting) submitInFlight = false;
  },
);
</script>

<template>
  <form class="consultation-composer" aria-labelledby="consultation-title" @submit.prevent="submit">
    <div class="consultation-hero">
      <h1 id="consultation-title">何を相談しますか。</h1>
    </div>

    <label class="prompt-field">
      相談内容
      <textarea
        v-model="prompt"
        rows="8"
        :maxlength="MAX_CONSULTATION_PROMPT_LENGTH"
        placeholder="例: 夜間通知を減らしたい。既存設定を壊さず、まず小さく試すにはどうすべきか相談したい。"
      ></textarea>
    </label>

    <fieldset class="participant-picker">
      <legend>参加エージェント</legend>
      <p class="muted participant-hint">2〜4件選択</p>
      <p v-if="loading" class="muted">候補を読み込んでいます…</p>
      <p v-else-if="loadError" class="action-error standalone">{{ loadError }}</p>
      <div v-else class="participant-options">
        <label v-for="profile in profiles" :key="profile.id" class="participant-option">
          <input
            type="checkbox"
            :checked="selectedIds.includes(profile.id)"
            :disabled="starting"
            @change="toggle(profile.id)"
          />
          <span>
            <b>{{ profile.label }}</b>
            <small>{{ profile.id }}</small>
          </span>
        </label>
      </div>
    </fieldset>

    <label class="target-field">
      Issue（任意）
      <input
        v-model="target"
        type="text"
        placeholder="owner/repo#123（空欄なら紐付けなし）"
        :disabled="starting"
      />
    </label>

    <div class="consultation-actions">
      <button
        class="start-button"
        type="submit"
        :disabled="starting || loading || loadError !== null"
      >
        {{ starting ? "開始中…" : "相談を開始" }}
      </button>
    </div>
    <p v-if="validationError" class="action-error standalone" aria-live="polite">
      {{ validationError }}
    </p>
    <p v-else-if="startError" class="action-error standalone" aria-live="polite">
      {{ startError }}
    </p>
    <p v-else-if="disabledReason && prompt.trim().length > 0" class="muted">{{ disabledReason }}</p>
  </form>
</template>
