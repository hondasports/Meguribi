<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  DiscussionIssue,
  DiscussionIssuesResponse,
  DiscussionProfile,
  StartDiscussionInput,
} from "../consultation-api.js";
import { validateConsultationInput } from "../consultation-api.js";
import type { DiscussionMcpPolicy } from "../consultation-api.js";
import { MAX_CONSULTATION_PROMPT_LENGTH } from "../consultation-contract.js";
import {
  discussionMcpPolicyAfterSubmit,
  initialDiscussionMcpPolicy,
} from "../consultation-view.js";

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
const issuePickerVisible = ref(false);
const issues = ref<DiscussionIssue[]>([]);
const issuesLoading = ref(false);
const issuesError = ref<string | null>(null);
const selectedIds = ref<string[]>([]);
const discussionMcpPolicy = ref<DiscussionMcpPolicy>(initialDiscussionMcpPolicy());
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

function openIssuePicker(): void {
  issuePickerVisible.value = true;
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
  if (submitInFlight || props.starting) return;
  const error = validateConsultationInput({ prompt: prompt.value, profileIds: selectedIds.value });
  validationError.value = error;
  if (error !== null) return;
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

    <fieldset class="mcp-policy-picker">
      <legend>MCP（CLIに保存した外部ツール設定）</legend>
      <p class="muted participant-hint">この相談で使うか選択してください。</p>
      <div class="participant-options mcp-policy-options">
        <label class="participant-option mcp-policy-option">
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
        <label class="participant-option mcp-policy-option">
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
    </fieldset>

    <div class="issue-auxiliary">
      <button
        v-if="!issuePickerVisible"
        class="secondary-link-button issue-add-button"
        type="button"
        :disabled="starting"
        @click="openIssuePicker"
      >
        Issueを追加（任意）
      </button>
      <section v-else class="issue-picker" aria-labelledby="issue-picker-title">
        <div class="issue-picker-header">
          <h2 id="issue-picker-title">Issue（任意）</h2>
          <button
            class="secondary-link-button"
            type="button"
            :disabled="starting || target.trim().length === 0"
            @click="clearIssue"
          >
            紐付けを解除
          </button>
        </div>
        <p v-if="issuesLoading" class="muted">Issue一覧を読み込んでいます…</p>
        <p v-else-if="issuesError" class="issue-load-error" role="status">
          Issue一覧を読み込めませんでした。手入力は使えます。
        </p>
        <fieldset v-if="issues.length > 0" class="issue-options">
          <legend>既存Issue</legend>
          <label v-for="issue in issues" :key="issue.target" class="issue-option">
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
        </fieldset>
        <p v-else-if="!issuesLoading && issuesError === null" class="muted">
          選択できるIssueはありません
        </p>
        <label class="target-field manual-target-field">
          別のIssueを手入力
          <input
            v-model="target"
            type="text"
            placeholder="owner/repo#123（空欄なら紐付けなし）"
            :disabled="starting"
          />
        </label>
      </section>
    </div>

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
