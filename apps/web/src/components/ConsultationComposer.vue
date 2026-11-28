<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  DiscussionIssue,
  DiscussionIssuesResponse,
  DiscussionMcpPolicy,
  DiscussionProfile,
  StartDiscussionInput,
} from "../consultation-api.js";
import { validateConsultationInput } from "../consultation-api.js";
import { MAX_CONSULTATION_PROMPT_LENGTH } from "../consultation-contract.js";
import {
  discussionMcpPolicyAfterSubmit,
  initialDiscussionMcpPolicy,
} from "../consultation-view.js";
import {
  participantToolbarSummary,
  shouldOpenOptionsForValidation,
} from "../consultation-composer-view.js";
import { shouldSubmitOnEnter } from "../input-keyboard.js";

const props = defineProps<{
  profiles: DiscussionProfile[];
  defaultProfileIds: string[];
  loading: boolean;
  starting: boolean;
  loadError: string | null;
  startError: string | null;
  loadIssues: () => Promise<DiscussionIssuesResponse>;
}>();

const emit = defineEmits<{
  start: [input: StartDiscussionInput];
}>();

const prompt = ref("");
const target = ref("");
const issues = ref<DiscussionIssue[]>([]);
const issuesLoading = ref(false);
const issuesError = ref<string | null>(null);
const selectedIds = ref<string[]>([]);
const discussionMcpPolicy = ref<DiscussionMcpPolicy>(initialDiscussionMcpPolicy());
const validationError = ref<string | null>(null);
const optionsOpen = ref(false);
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

const toolbarSummary = computed(() => {
  const issue = target.value.trim().length > 0 ? "Issueあり" : "Issueなし";
  return `${participantToolbarSummary(selectedIds.value, props.profiles)} / ${issue} / MCP ${discussionMcpPolicy.value}`;
});

function ensureIssuesLoaded(): void {
  if (issuesLoading.value || issuesError.value !== null || issues.value.length > 0) return;
  issuesLoading.value = true;
  void props
    .loadIssues()
    .then((result) => {
      issues.value = result.issues;
    })
    .catch((cause: unknown) => {
      issuesError.value =
        cause instanceof Error ? cause.message : "Issue一覧を読み込めませんでした";
    })
    .finally(() => {
      issuesLoading.value = false;
    });
}

function toggleOptions(): void {
  optionsOpen.value = !optionsOpen.value;
  if (optionsOpen.value) ensureIssuesLoaded();
}

function selectIssue(issueTarget: string): void {
  target.value = issueTarget;
}

function clearIssue(): void {
  target.value = "";
}

function toggle(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((candidate) => candidate !== id)
    : [...selectedIds.value, id];
}

function selectDiscussionMcpPolicy(policy: DiscussionMcpPolicy): void {
  discussionMcpPolicy.value = policy;
}

function submit(): void {
  if (submitInFlight || props.starting || props.loading || props.loadError !== null) return;
  const error = validateConsultationInput({ prompt: prompt.value, profileIds: selectedIds.value });
  validationError.value = error;
  if (error !== null) {
    if (shouldOpenOptionsForValidation(error)) {
      optionsOpen.value = true;
      ensureIssuesLoaded();
    }
    return;
  }
  submitInFlight = true;
  const submittedMcpPolicy = discussionMcpPolicy.value;
  discussionMcpPolicy.value = discussionMcpPolicyAfterSubmit();
  emit("start", {
    prompt: prompt.value.trim(),
    profileIds: [...selectedIds.value],
    discussionMcpPolicy: submittedMcpPolicy,
    ...(target.value.trim().length > 0 ? { target: target.value.trim() } : {}),
  });
}

function onPromptKeydown(event: KeyboardEvent): void {
  if (!shouldSubmitOnEnter(event)) return;
  event.preventDefault();
  submit();
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

    <div class="composer-card">
      <label class="sr-only" for="consultation-prompt">相談内容</label>
      <textarea
        id="consultation-prompt"
        v-model="prompt"
        rows="6"
        :maxlength="MAX_CONSULTATION_PROMPT_LENGTH"
        :disabled="starting"
        placeholder="例: 夜間通知を減らしたい。既存設定を壊さず、まず小さく試すにはどうすべきか相談したい。"
        @keydown="onPromptKeydown"
      ></textarea>

      <div class="composer-controls">
        <button
          class="toolbar-toggle"
          type="button"
          :aria-expanded="optionsOpen"
          aria-controls="composer-options"
          :disabled="starting"
          @click="toggleOptions"
        >
          <span>{{ toolbarSummary }}</span>
          <span class="toggle-chevron" aria-hidden="true">{{ optionsOpen ? "▾" : "▸" }}</span>
        </button>
        <button
          class="send-button"
          type="submit"
          :disabled="starting || loading || loadError !== null"
        >
          {{ starting ? "開始中…" : "相談を開始" }}
        </button>
      </div>

      <div v-if="optionsOpen" id="composer-options" class="composer-options">
        <section class="tool-section" aria-labelledby="participant-tools-title">
          <div class="tool-heading">
            <h2 id="participant-tools-title">参加CLI</h2>
            <p>2〜4件選択</p>
          </div>
          <p v-if="loading" class="muted">候補を読み込んでいます…</p>
          <p v-else-if="loadError" class="action-error standalone">{{ loadError }}</p>
          <div v-else class="option-grid">
            <label v-for="profile in profiles" :key="profile.id" class="select-option">
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
        </section>

        <section class="tool-section" aria-labelledby="issue-tools-title">
          <div class="tool-heading issue-heading">
            <div>
              <h2 id="issue-tools-title">Issue（任意）</h2>
              <p>必要なときだけ紐付けます</p>
            </div>
            <button
              class="clear-button"
              type="button"
              :disabled="starting || target.trim().length === 0"
              @click="clearIssue"
            >
              解除
            </button>
          </div>
          <p v-if="issuesLoading" class="muted">Issue一覧を読み込んでいます…</p>
          <p v-else-if="issuesError" class="issue-load-error" role="status">
            Issue一覧を読み込めませんでした。手入力は使えます。
          </p>
          <div v-if="issues.length > 0" class="issue-options">
            <label v-for="issue in issues" :key="issue.target" class="select-option issue-option">
              <input
                type="radio"
                name="consultation-issue"
                :checked="target === issue.target"
                :disabled="starting"
                @change="selectIssue(issue.target)"
              />
              <span>
                <b>{{ issue.target }}</b>
                <small>{{ issue.title }}</small>
              </span>
            </label>
          </div>
          <p v-else-if="!issuesLoading && issuesError === null" class="muted">
            選択できるIssueはありません
          </p>
          <label class="manual-target">
            別のIssueを手入力
            <input
              v-model="target"
              type="text"
              placeholder="owner/repo#123（空欄なら紐付けなし）"
              :disabled="starting"
            />
          </label>
        </section>

        <section class="tool-section" aria-labelledby="mcp-tools-title">
          <div class="tool-heading">
            <h2 id="mcp-tools-title">MCP（CLIに保存した外部ツール設定）</h2>
            <p>この相談で使うか選択してください。</p>
          </div>
          <div class="option-grid mcp-options">
            <label class="select-option">
              <input
                type="radio"
                name="discussion-mcp-policy"
                value="deny"
                :checked="discussionMcpPolicy === 'deny'"
                :disabled="starting"
                @change="selectDiscussionMcpPolicy('deny')"
              />
              <span>
                <b>使わない（deny）</b>
                <small
                  >MCP接続を検知した場合は停止します。完全な隔離を保証するものではありません。</small
                >
              </span>
            </label>
            <label class="select-option">
              <input
                type="radio"
                name="discussion-mcp-policy"
                value="allow"
                :checked="discussionMcpPolicy === 'allow'"
                :disabled="starting"
                @change="selectDiscussionMcpPolicy('allow')"
              />
              <span>
                <b>この相談だけ使う（allow）</b>
                <small>明示したこの相談だけに適用します。</small>
              </span>
            </label>
          </div>
        </section>
      </div>
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

<style scoped>
.consultation-composer {
  display: grid;
  gap: 18px;
  border: 0;
  background: transparent;
  padding: 0;
}

.consultation-hero h1 {
  margin: 0.2rem 0 0.8rem;
  font-size: clamp(1.7rem, 3.4vw, 2.7rem);
  letter-spacing: -0.03em;
}

.composer-card {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #303638;
  border-radius: 16px;
  background: #101213;
  color: #edf1ee;
  padding: 12px;
  box-shadow: 0 16px 42px rgba(0, 0, 0, 0.28);
}

.composer-card:focus-within {
  border-color: #5c8983;
  box-shadow:
    0 0 0 1px rgba(115, 212, 194, 0.18),
    0 16px 42px rgba(0, 0, 0, 0.28);
}

.composer-card > textarea {
  box-sizing: border-box;
  display: block;
  width: 100%;
  min-height: 112px;
  max-height: 320px;
  border: 0;
  outline: none;
  resize: vertical;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.55;
  padding: 4px 4px 12px;
}

.composer-card > textarea::placeholder {
  color: #747c7a;
}

.composer-card > textarea:disabled {
  color: #6f7775;
  cursor: not-allowed;
}

.composer-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-top: 1px solid #242829;
  padding-top: 10px;
}

.toolbar-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 38px;
  min-width: 0;
  flex: 1;
  border: 1px solid #303638;
  border-radius: 10px;
  background: #161819;
  color: #b9c1be;
  cursor: pointer;
  font-size: 0.82rem;
  padding: 7px 10px;
  text-align: left;
}

.toolbar-toggle:hover:not(:disabled) {
  border-color: #49514f;
  color: #edf1ee;
}

.toggle-chevron {
  color: #73d4c2;
  margin-left: auto;
}

.send-button {
  min-width: 104px;
  min-height: 40px;
  border: 0;
  border-radius: 999px;
  background: #73d4c2;
  color: #06211d;
  cursor: pointer;
  font-weight: 800;
  padding: 8px 16px;
}

.send-button:hover:not(:disabled) {
  background: #8be3d2;
}

.send-button:disabled,
.toolbar-toggle:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

.composer-options {
  display: grid;
  gap: 12px;
  border-top: 1px solid #242829;
  margin-top: 10px;
  padding-top: 12px;
}

.tool-section {
  border: 1px solid #282d2e;
  border-radius: 12px;
  background: #0c0e0f;
  padding: 10px;
}

.tool-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.tool-heading h2 {
  font-size: 0.86rem;
  margin: 0;
}

.tool-heading p {
  color: #899390;
  font-size: 0.74rem;
  margin: 3px 0 0;
}

.option-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 8px;
}

.select-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 44px;
  border: 1px solid #303638;
  border-radius: 10px;
  background: #141719;
  cursor: pointer;
  padding: 8px;
}

.select-option:has(input:checked) {
  border-color: rgba(115, 212, 194, 0.62);
  background: rgba(115, 212, 194, 0.08);
}

.select-option input {
  width: 1.05rem;
  height: 1.05rem;
  margin-top: 0.1rem;
}

.select-option span {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.select-option b {
  font-size: 0.82rem;
}

.select-option small {
  color: #899390;
  font-size: 0.72rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.issue-options {
  display: grid;
  gap: 7px;
  max-height: 12rem;
  overflow-y: auto;
  margin-bottom: 8px;
}

.issue-heading {
  align-items: flex-start;
}

.clear-button {
  border: 1px solid #303638;
  border-radius: 999px;
  background: transparent;
  color: #b9c1be;
  cursor: pointer;
  font-size: 0.75rem;
  min-height: 30px;
  padding: 4px 10px;
}

.clear-button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.manual-target {
  display: grid;
  gap: 5px;
  color: #899390;
  font-size: 0.75rem;
}

.manual-target input {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #303638;
  border-radius: 9px;
  background: #101213;
  color: #edf1ee;
  font: inherit;
  min-height: 38px;
  padding: 7px 9px;
}

.manual-target input:focus-visible,
.select-option input:focus-visible,
.toolbar-toggle:focus-visible,
.send-button:focus-visible,
.clear-button:focus-visible {
  outline: 2px solid rgba(115, 212, 194, 0.68);
  outline-offset: 2px;
}

.muted {
  color: #899390;
  font-size: 0.78rem;
  margin: 0;
}

.issue-load-error {
  color: #d7a8a8;
  font-size: 0.78rem;
  margin: 0 0 8px;
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

@media (max-width: 640px) {
  .composer-controls {
    align-items: stretch;
    flex-direction: column;
  }

  .send-button {
    width: 100%;
  }
}
</style>
