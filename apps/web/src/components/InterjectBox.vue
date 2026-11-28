<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  canInterject: boolean;
  sending: boolean;
}>();

const emit = defineEmits<{
  submit: [message: string];
}>();

const message = ref("");
const canSubmit = computed(
  () => props.canInterject && !props.sending && message.value.trim().length > 0,
);

function submit(): void {
  if (!canSubmit.value) return;
  emit("submit", message.value);
}

function clear(): void {
  message.value = "";
}

defineExpose({ clear });
</script>

<template>
  <form class="interject-box" aria-label="議論への発言挿入" @submit.prevent="submit">
    <label>
      発言を挿入
      <textarea
        v-model="message"
        rows="3"
        maxlength="4000"
        :disabled="!canInterject || sending"
        placeholder="議論中のエージェントへ伝えたいことを書く"
      ></textarea>
    </label>
    <div class="interject-actions">
      <span v-if="!canInterject" class="interject-disabled-reason">議論は終了しています</span>
      <span v-else>{{ message.length }}/4000</span>
      <button type="submit" :disabled="!canSubmit">
        {{ sending ? "送信中…" : "送信" }}
      </button>
    </div>
  </form>
</template>
