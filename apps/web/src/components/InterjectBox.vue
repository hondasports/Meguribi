<script setup lang="ts">
import { computed, ref } from "vue";
import { shouldSubmitOnEnter } from "../input-keyboard.js";

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

function onMessageKeydown(event: KeyboardEvent): void {
  if (!shouldSubmitOnEnter(event)) return;
  event.preventDefault();
  submit();
}

function clear(): void {
  message.value = "";
}

defineExpose({ clear });
</script>

<template>
  <form class="interject-box" aria-label="議論への発言挿入" @submit.prevent="submit">
    <div class="interject-card">
      <label class="sr-only" for="interject-message">発言を挿入</label>
      <textarea
        id="interject-message"
        v-model="message"
        rows="2"
        maxlength="4000"
        :disabled="!canInterject || sending"
        placeholder="議論中のエージェントへ伝えたいことを書く（Enterで送信、Shift+Enterで改行）"
        @keydown="onMessageKeydown"
      ></textarea>
      <div class="interject-footer">
        <span v-if="!canInterject" class="interject-disabled-reason">議論は終了しています</span>
        <span v-else class="interject-count">{{ message.length }}/4000</span>
        <button class="interject-send" type="submit" :disabled="!canSubmit">
          {{ sending ? "送信中…" : "送信" }}
        </button>
      </div>
    </div>
  </form>
</template>

<style scoped>
.interject-box {
  margin: 0;
}

.interject-card {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #303638;
  border-radius: 14px;
  background: #101213;
  padding: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.24);
}

.interject-card textarea {
  box-sizing: border-box;
  display: block;
  width: 100%;
  min-height: 54px;
  max-height: 180px;
  border: 0;
  outline: none;
  resize: vertical;
  background: transparent;
  color: #edf1ee;
  font: inherit;
  line-height: 1.5;
  padding: 3px 4px 8px;
}

.interject-card textarea::placeholder {
  color: #747c7a;
}

.interject-card textarea:disabled {
  color: #6f7775;
  cursor: not-allowed;
}

.interject-card:focus-within {
  border-color: #5c8983;
  box-shadow:
    0 0 0 1px rgba(115, 212, 194, 0.2),
    0 10px 30px rgba(0, 0, 0, 0.24);
}

.interject-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-height: 34px;
  border-top: 1px solid #242829;
  padding-top: 8px;
  color: #899390;
  font-size: 0.76rem;
}

.interject-disabled-reason {
  margin-right: auto;
}

.interject-count {
  margin-right: auto;
}

.interject-send {
  min-width: 64px;
  min-height: 34px;
  border: 0;
  border-radius: 999px;
  background: #73d4c2;
  color: #06211d;
  cursor: pointer;
  font-weight: 800;
  padding: 6px 13px;
}

.interject-send:hover:not(:disabled) {
  background: #8be3d2;
}

.interject-send:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.interject-send:focus-visible,
.interject-card textarea:focus-visible {
  outline: 2px solid rgba(115, 212, 194, 0.68);
  outline-offset: 2px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
