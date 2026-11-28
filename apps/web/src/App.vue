<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type { RunDetail, RunSummary } from "../server/run-store-api.js";
import ActivityBar from "./components/ActivityBar.vue";
import AgentPanes from "./components/AgentPanes.vue";
import ConclusionPanel from "./components/ConclusionPanel.vue";
import ConsultationComposer from "./components/ConsultationComposer.vue";
import DiscussionThread from "./components/DiscussionThread.vue";
import InterjectBox from "./components/InterjectBox.vue";
import RunList from "./components/RunList.vue";
import RunPipeline from "./components/RunPipeline.vue";
import {
  createConsultationApi,
  type DiscussionProfile,
  type StartDiscussionInput,
} from "./consultation-api.js";
import { consultationTitle, isConsultationCommand } from "./consultation-view.js";
import { createDiscussionApi, type DiscussionDetail } from "./discussion-api.js";
import { buildConclusionView } from "./discussion-view.js";
import { applyDetail, applyLog, createRunViewState } from "./run-view.js";

type CommandId =
  | "doctor"
  | "init"
  | "discover"
  | "hypothesis"
  | "promote"
  | "explore"
  | "require"
  | "plan"
  | "review"
  | "run"
  | "resume"
  | "measure"
  | "cleanup";

interface CommandDefinition {
  id: CommandId;
  label: string;
  description: string;
  group: string;
  requiresTarget: boolean;
}

interface OutputLine {
  stream: "stdout" | "stderr" | "system";
  text: string;
}

const commandGroups = ["準備", "プロダクトループ", "Delivery"];
const commands: CommandDefinition[] = [
  {
    id: "doctor",
    label: "doctor",
    description: "実装エージェントの準備状態を診断",
    group: "準備",
    requiresTarget: false,
  },
  {
    id: "init",
    label: "init",
    description: "リポジトリと設定を診断",
    group: "準備",
    requiresTarget: false,
  },
  {
    id: "discover",
    label: "discover",
    description: "根拠から課題候補を抽出",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "hypothesis",
    label: "hypothesis",
    description: "Issue の仮説を構造化",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "promote",
    label: "promote",
    description: "Problem 草案へ昇格",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "explore",
    label: "explore",
    description: "解決方針を比較",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "require",
    label: "require",
    description: "選択した方針から要件化",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "measure",
    label: "measure",
    description: "リリース後の測定草案を作成",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "plan",
    label: "plan",
    description: "Codex SDK で実装計画を作成",
    group: "Delivery",
    requiresTarget: true,
  },
  {
    id: "review",
    label: "review",
    description: "既存 Run を Codex SDK で再レビュー",
    group: "Delivery",
    requiresTarget: true,
  },
  {
    id: "run",
    label: "run",
    description: "実装・検証・レビューを実行",
    group: "Delivery",
    requiresTarget: true,
  },
  {
    id: "resume",
    label: "resume",
    description: "中断した Run を再開",
    group: "Delivery",
    requiresTarget: true,
  },
  {
    id: "cleanup",
    label: "cleanup",
    description: "完了済み worktree を整理",
    group: "Delivery",
    requiresTarget: true,
  },
];

const selectedCommand = ref<CommandId>("run");
const running = ref(false);
const runId = ref<string | null>(null);
const connection = ref<"offline" | "online">("offline");
const output = ref<OutputLine[]>([]);
const result = ref<string | null>(null);
const error = ref<string | null>(null);
const form = reactive({
  repoPath: "",
  target: "local/todo#1",
  userRequest: "",
  implementer: "devin",
  solution: "1",
  period: "14d",
  branch: "meguribi/issue-1",
  worktreePath: "",
  local: true,
  nonInteractive: true,
  allowInheritedMcp: true,
  noPush: true,
  noPr: true,
});

const selected = computed(() => commands.find((command) => command.id === selectedCommand.value)!);

function selectCommand(id: CommandId): void {
  if (running.value) return;
  selectedCommand.value = id;
  error.value = null;
  result.value = null;
}

function append(stream: OutputLine["stream"], text: string): void {
  output.value.push(
    ...text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => ({ stream, text: line })),
  );
}

function buildOptions(): Record<string, unknown> {
  return {
    repoPath: form.repoPath || undefined,
    userRequest: form.userRequest || undefined,
    implementer: form.implementer,
    local: form.local,
    nonInteractive: form.nonInteractive,
    allowInheritedMcp: form.allowInheritedMcp,
    noPush: form.noPush,
    noPr: form.noPr,
    branch: form.branch || undefined,
    worktreePath: form.worktreePath || undefined,
    solution: Number(form.solution),
    period: form.period || undefined,
  };
}

async function runCommand(): Promise<void> {
  if (running.value) return;
  running.value = true;
  output.value = [];
  result.value = null;
  error.value = null;
  append("system", `meguribi ${selectedCommand.value} を開始しています…`);

  try {
    const response = await fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: selectedCommand.value,
        target: form.target,
        options: buildOptions(),
      }),
    });
    const payload = (await response.json()) as { runId?: string; error?: string };
    if (!response.ok || !payload.runId)
      throw new Error(payload.error ?? "コマンドを開始できませんでした");
    runId.value = payload.runId;
    connection.value = "online";
    const events = new EventSource(`/api/runs/${encodeURIComponent(payload.runId)}/events`);
    events.addEventListener("output", (event) => {
      const line = JSON.parse((event as MessageEvent).data) as OutputLine;
      append(line.stream, line.text);
    });
    events.addEventListener("complete", (event) => {
      const completed = JSON.parse((event as MessageEvent).data) as { exitCode: number };
      result.value = completed.exitCode === 0 ? "成功" : `終了コード ${completed.exitCode}`;
      append(
        "system",
        completed.exitCode === 0
          ? "コマンドが完了しました。"
          : "コマンドが失敗しました。ログを確認してください。",
      );
      running.value = false;
      connection.value = "offline";
      events.close();
    });
    events.onerror = () => {
      if (running.value)
        error.value = "実行ログとの接続が切れました。RunStore を確認してください。";
      connection.value = "offline";
      events.close();
    };
  } catch (cause) {
    running.value = false;
    error.value = cause instanceof Error ? cause.message : String(cause);
    append("stderr", error.value);
  }
}

const activeView = ref<"consult" | "commands" | "runs">("consult");
const runSummaries = ref<RunSummary[]>([]);
const runsLoading = ref(false);
const runListError = ref<string | null>(null);
const runStreamError = ref<string | null>(null);
const selectedRunId = ref<string | null>(null);
const runView = ref(createRunViewState());
const runDetail = computed(() => runView.value.detail);
const discussionApi = createDiscussionApi();
const consultationApi = createConsultationApi();
const consultationProfiles = ref<DiscussionProfile[]>([]);
const consultationDefaultProfileIds = ref<string[]>([]);
const consultationProfilesLoading = ref(false);
const consultationProfilesError = ref<string | null>(null);
const consultationStartError = ref<string | null>(null);
const consultationStarting = ref(false);
const consultationComposerVisible = ref(true);
const consultationPrompts = ref<Record<string, string>>({});
const discussionDetail = ref<DiscussionDetail | null>(null);
const discussionLoading = ref(false);
const discussionError = ref<string | null>(null);
const discussionActionError = ref<string | null>(null);
const discussionActionNotice = ref<string | null>(null);
const interjectionError = ref<string | null>(null);
const interjectionNotice = ref<string | null>(null);
const discussionActionPending = ref<"say" | "approve" | "reject" | null>(null);
const discussionThreadRef = ref<InstanceType<typeof DiscussionThread> | null>(null);
const interjectBoxRef = ref<InstanceType<typeof InterjectBox> | null>(null);
const activeConsultationPrompt = computed(() => {
  const runId = selectedRunId.value;
  return runId === null ? null : (consultationPrompts.value[runId] ?? null);
});
const activeConsultationTitle = computed(() =>
  activeConsultationPrompt.value === null
    ? "相談"
    : consultationTitle(activeConsultationPrompt.value),
);
const selectedRunTitle = computed(() => {
  const state = runDetail.value?.state;
  if (state === undefined) return "相談";
  if (state.command === "consult") return activeConsultationTitle.value;
  return `${state.repository}#${String(state.issueNumber)}`;
});
const selectedRunStatusLabel = computed(() => {
  const state = runDetail.value?.state;
  return state === undefined ? "" : runStatusLabel(state.status);
});
const conclusionView = computed(() => {
  const detail = discussionDetail.value;
  return detail?.conclusion === null || detail?.conclusion === undefined
    ? null
    : buildConclusionView(detail.conclusion, detail.turns);
});
let runListTimer: ReturnType<typeof setInterval> | undefined;
let runEvents: EventSource | undefined;
let discussionLoadingFor: string | null = null;

const runStatusLabels: Record<string, string> = {
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

function runStatusLabel(status: string): string {
  return runStatusLabels[status] ?? status;
}

async function loadConsultationProfiles(): Promise<void> {
  consultationProfilesLoading.value = true;
  consultationProfilesError.value = null;
  try {
    const result = await consultationApi.loadProfiles();
    consultationProfiles.value = result.profiles;
    consultationDefaultProfileIds.value = result.defaultProfileIds;
  } catch (cause) {
    consultationProfilesError.value = errorText(cause);
  } finally {
    consultationProfilesLoading.value = false;
  }
}

async function startConsultation(input: StartDiscussionInput): Promise<void> {
  if (consultationStarting.value) return;
  consultationStarting.value = true;
  consultationStartError.value = null;
  try {
    const result = await consultationApi.startDiscussion(input);
    consultationPrompts.value = { ...consultationPrompts.value, [result.runId]: input.prompt };
    consultationComposerVisible.value = false;
    await loadRuns();
    selectRun(result.runId);
  } catch (cause) {
    consultationStartError.value = errorText(cause);
  } finally {
    consultationStarting.value = false;
  }
}

function showNewConsultation(): void {
  consultationStartError.value = null;
  consultationComposerVisible.value = true;
}

function returnToConsultation(): void {
  consultationComposerVisible.value = false;
}

function setPaneMode(value: "agents" | "all"): void {
  runView.value = { ...runView.value, selectedPane: value };
}

function closeRunEvents(): void {
  runEvents?.close();
  runEvents = undefined;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function resetDiscussionState(): void {
  discussionDetail.value = null;
  discussionLoading.value = false;
  discussionLoadingFor = null;
  discussionError.value = null;
  discussionActionError.value = null;
  discussionActionNotice.value = null;
  interjectionError.value = null;
  interjectionNotice.value = null;
  discussionActionPending.value = null;
}

async function loadDiscussion(runId: string): Promise<void> {
  if (discussionLoadingFor === runId) return;
  discussionLoadingFor = runId;
  discussionLoading.value = true;
  discussionError.value = null;
  try {
    const detail = await discussionApi.load(runId);
    if (selectedRunId.value === runId) discussionDetail.value = detail;
  } catch (cause) {
    if (selectedRunId.value === runId) discussionError.value = errorText(cause);
  } finally {
    if (discussionLoadingFor === runId) {
      discussionLoadingFor = null;
      if (selectedRunId.value === runId) discussionLoading.value = false;
    }
  }
}

async function refreshRunDetail(runId: string): Promise<void> {
  const response = await fetch(`/api/run-store/runs/${encodeURIComponent(runId)}`).catch(
    () => null,
  );
  if (response === null || !response.ok) return;
  try {
    const detail = (await response.json()) as RunDetail;
    if (selectedRunId.value === runId) runView.value = applyDetail(runView.value, detail);
  } catch {
    return;
  }
}

function actionFailureText(result: { stderr?: string }, fallback: string): string {
  const stderr = result.stderr?.trim();
  return stderr !== undefined && stderr.length > 0 ? stderr : fallback;
}

async function submitInterjection(message: string): Promise<void> {
  const runId = selectedRunId.value;
  if (runId === null || discussionActionPending.value !== null) return;
  discussionActionPending.value = "say";
  interjectionError.value = null;
  interjectionNotice.value = null;
  try {
    const result = await discussionApi.say(runId, message);
    if (result.ok) {
      interjectBoxRef.value?.clear();
      interjectionNotice.value = result.stdout?.trim() || "発言を送りました";
    } else {
      interjectionError.value = actionFailureText(result, "発言を送れませんでした");
    }
  } catch (cause) {
    interjectionError.value = errorText(cause);
  } finally {
    discussionActionPending.value = null;
  }
}

async function approveCurrentDiscussion(): Promise<void> {
  const runId = selectedRunId.value;
  if (runId === null || discussionActionPending.value !== null) return;
  discussionActionPending.value = "approve";
  discussionActionError.value = null;
  discussionActionNotice.value = null;
  try {
    const result = await discussionApi.approve(runId);
    if (result.ok) {
      discussionActionNotice.value = result.stdout?.trim() || "結論を承認しました";
      await Promise.all([loadDiscussion(runId), refreshRunDetail(runId)]);
      void loadRuns();
    } else {
      discussionActionError.value = actionFailureText(result, "結論を承認できませんでした");
    }
  } catch (cause) {
    discussionActionError.value = errorText(cause);
  } finally {
    discussionActionPending.value = null;
  }
}

async function rejectCurrentDiscussion(payload: { reason: string; redo: boolean }): Promise<void> {
  const runId = selectedRunId.value;
  if (runId === null || discussionActionPending.value !== null) return;
  discussionActionPending.value = "reject";
  discussionActionError.value = null;
  discussionActionNotice.value = null;
  try {
    const result = await discussionApi.reject(runId, payload.reason, payload.redo);
    if (result.ok) {
      discussionActionNotice.value =
        result.stdout?.trim() ||
        (payload.redo ? "却下して再議論を開始しました" : "結論を却下しました");
      await Promise.all([loadDiscussion(runId), refreshRunDetail(runId)]);
      if (payload.redo) openRunEvents(runId);
      void loadRuns();
    } else {
      discussionActionError.value = actionFailureText(result, "結論を却下できませんでした");
    }
  } catch (cause) {
    discussionActionError.value = errorText(cause);
  } finally {
    discussionActionPending.value = null;
  }
}

function openDiscussionTurn(turnId: string): void {
  discussionThreadRef.value?.focusTurn(turnId);
}

function openRunEvents(runId: string): void {
  closeRunEvents();
  let streamEnded = false;
  const events = new EventSource(`/api/run-store/runs/${encodeURIComponent(runId)}/stream`);
  runEvents = events;
  events.addEventListener("log", (event) => {
    if (selectedRunId.value !== runId) return;
    const chunk = JSON.parse((event as MessageEvent).data) as { pane: string; text: string };
    runView.value = applyLog(runView.value, chunk);
  });
  events.addEventListener("detail", (event) => {
    if (selectedRunId.value !== runId) return;
    const detail = JSON.parse((event as MessageEvent).data) as NonNullable<typeof runDetail.value>;
    runView.value = applyDetail(runView.value, detail);
    if (
      isConsultationCommand(detail.state.command) &&
      discussionDetail.value === null &&
      discussionLoadingFor !== runId
    ) {
      void loadDiscussion(runId);
    }
  });
  events.addEventListener("discussion", (event) => {
    if (selectedRunId.value !== runId) return;
    discussionDetail.value = JSON.parse((event as MessageEvent).data) as DiscussionDetail;
    discussionError.value = null;
  });
  events.addEventListener("end", () => {
    streamEnded = true;
    events.close();
  });
  events.addEventListener("error", (event) => {
    if (selectedRunId.value !== runId) return;
    const payload = JSON.parse((event as MessageEvent).data) as { message?: string };
    runStreamError.value = payload.message ?? "Run の読み込みでエラーが発生しました";
  });
  events.onerror = () => {
    if (!streamEnded && selectedRunId.value === runId) {
      runStreamError.value = "Run のライブログとの接続が切れました";
    }
    events.close();
  };
}

function selectRun(runId: string): void {
  if (selectedRunId.value === runId) return;
  selectedRunId.value = runId;
  runView.value = createRunViewState();
  runStreamError.value = null;
  resetDiscussionState();
  if (isConsultationCommand(runSummaries.value.find((run) => run.runId === runId)?.command ?? "")) {
    void loadDiscussion(runId);
  }
  openRunEvents(runId);
}

function clearSelectedRun(): void {
  selectedRunId.value = null;
  runView.value = createRunViewState();
  resetDiscussionState();
  closeRunEvents();
}

async function loadRuns(): Promise<void> {
  runsLoading.value = true;
  try {
    const response = await fetch("/api/run-store/runs?limit=50");
    if (!response.ok)
      throw new Error(`Run 一覧を取得できませんでした (${String(response.status)})`);
    const runs = (await response.json()) as RunSummary[];
    runSummaries.value = runs;
    runListError.value = null;
    if (runs.length === 0) {
      clearSelectedRun();
    } else if (
      selectedRunId.value === null ||
      !runs.some((run) => run.runId === selectedRunId.value)
    ) {
      selectRun(runs[0]!.runId);
    }
  } catch (cause) {
    runListError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    runsLoading.value = false;
  }
}

onMounted(async () => {
  void loadRuns();
  void loadConsultationProfiles();
  runListTimer = setInterval(() => void loadRuns(), 5000);
  try {
    const response = await fetch("/api/health");
    if (response.ok) connection.value = "online";
  } catch {
    connection.value = "offline";
  }
});

onBeforeUnmount(() => {
  if (runListTimer !== undefined) clearInterval(runListTimer);
  closeRunEvents();
});
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">↻</span>
        <div><strong>Meguribi</strong><span>Command Desk</span></div>
      </div>
      <nav class="view-tabs" aria-label="画面切り替え">
        <button
          :class="['view-tab', { active: activeView === 'consult' }]"
          type="button"
          @click="activeView = 'consult'"
        >
          相談
        </button>
        <button
          :class="['view-tab', { active: activeView === 'commands' }]"
          type="button"
          @click="activeView = 'commands'"
        >
          既存操作
        </button>
        <button
          :class="['view-tab', { active: activeView === 'runs' }]"
          type="button"
          @click="activeView = 'runs'"
        >
          Run履歴
        </button>
      </nav>
      <div class="connection">
        <span :class="['dot', connection]"></span
        >{{ connection === "online" ? "ローカルブリッジ接続中" : "待機中" }}
      </div>
    </header>

    <div class="workspace">
      <template v-if="activeView === 'consult'">
        <section class="content consultation-content">
          <div v-if="consultationComposerVisible" class="composer-header-row">
            <button
              v-if="isConsultationCommand(runDetail?.state.command ?? '')"
              class="secondary-link-button"
              type="button"
              @click="returnToConsultation"
            >
              相談へ戻る
            </button>
          </div>
          <ConsultationComposer
            v-if="consultationComposerVisible"
            :profiles="consultationProfiles"
            :default-profile-ids="consultationDefaultProfileIds"
            :loading="consultationProfilesLoading"
            :starting="consultationStarting"
            :load-error="consultationProfilesError"
            :start-error="consultationStartError"
            @start="startConsultation"
          />

          <section
            v-if="
              !consultationComposerVisible && isConsultationCommand(runDetail?.state.command ?? '')
            "
            class="discussion-area consultation-live"
          >
            <div class="consultation-live-header">
              <div>
                <h2>{{ selectedRunTitle }}</h2>
              </div>
              <div class="consultation-live-actions">
                <span class="badge">{{ selectedRunStatusLabel }}</span>
                <button class="secondary-link-button" type="button" @click="showNewConsultation">
                  新しい相談
                </button>
              </div>
            </div>
            <section class="consultation-prompt-card" aria-label="相談内容">
              <h3>相談内容</h3>
              <p>{{ activeConsultationPrompt ?? "相談内容は現在のAPI応答からは復元できません" }}</p>
            </section>
            <p v-if="discussionError" class="run-stream-error">{{ discussionError }}</p>
            <p v-else-if="discussionLoading" class="discussion-loading">議論を読み込んでいます…</p>
            <DiscussionThread ref="discussionThreadRef" :turns="discussionDetail?.turns ?? []" />
            <InterjectBox
              ref="interjectBoxRef"
              :can-interject="discussionDetail?.canInterject ?? false"
              :sending="discussionActionPending === 'say'"
              @submit="submitInterjection"
            />
            <p v-if="interjectionError" class="action-error standalone">{{ interjectionError }}</p>
            <p v-if="interjectionNotice" class="action-notice standalone">
              {{ interjectionNotice }}
            </p>
            <ConclusionPanel
              :view="conclusionView"
              :approval="discussionDetail?.approval ?? null"
              :can-decide="discussionDetail?.canDecide ?? false"
              :action-pending="discussionActionPending === 'say' ? null : discussionActionPending"
              :action-error="discussionActionError"
              :action-notice="discussionActionNotice"
              @approve="approveCurrentDiscussion"
              @reject="rejectCurrentDiscussion"
              @open-turn="openDiscussionTurn"
            />
          </section>
        </section>
      </template>

      <template v-else-if="activeView === 'commands'">
        <aside class="sidebar">
          <div class="eyebrow">COMMANDS</div>
          <section v-for="group in commandGroups" :key="group" class="command-group">
            <div class="group-label">{{ group }}</div>
            <button
              v-for="command in commands.filter((item) => item.group === group)"
              :key="command.id"
              :class="['command-item', { active: selectedCommand === command.id }]"
              @click="selectCommand(command.id)"
            >
              <span class="command-icon">{{
                command.id === "run" ? "▶" : command.id === "doctor" ? "✦" : "·"
              }}</span>
              <span
                ><b>{{ command.label }}</b
                ><small>{{ command.description }}</small></span
              >
            </button>
          </section>
        </aside>

        <section class="content">
          <div class="page-heading">
            <div>
              <div class="eyebrow">LOCAL ORCHESTRATOR</div>
              <h1>{{ selected.label }}</h1>
              <p>{{ selected.description }}</p>
            </div>
            <span class="badge">REAL CLI</span>
          </div>

          <div class="grid">
            <form class="card form-card" @submit.prevent="runCommand">
              <div class="card-heading">
                <div>
                  <span class="step">01</span>
                  <h2>実行設定</h2>
                </div>
                <span class="safe-label">● local-first</span>
              </div>
              <label v-if="selected.requiresTarget"
                >Target<input
                  v-model="form.target"
                  placeholder="owner/repo#123 または local/todo#1"
              /></label>
              <label
                >Repository path<input
                  v-model="form.repoPath"
                  :required="selectedCommand === 'init'"
                  placeholder="C:\\Users\\tatsuya\\Documents\\sourcecode\\todo"
                /><small v-if="selectedCommand === 'init'"
                  >initではこのパスのルートに .meguribi.yml を作成します。</small
                ></label
              >
              <label v-if="selectedCommand === 'plan'" class="request-field"
                >User request<textarea
                  v-model="form.userRequest"
                  rows="5"
                  maxlength="12000"
                  placeholder="例: WEBでTODOアプリを作って。"
                ></textarea
                ><small
                  >Issueの内容に加えて、今回作りたいものや重視したい条件を入力します。</small
                ></label
              >
              <div class="two-col">
                <label
                  >Implementer<select v-model="form.implementer">
                    <option value="devin">Devin ACP</option>
                    <option value="cursor">Cursor ACP</option>
                  </select></label
                >
                <label v-if="selectedCommand === 'require'"
                  >Solution number<input v-model="form.solution" type="number" min="1"
                /></label>
                <label v-else-if="selectedCommand === 'measure'"
                  >Period<input v-model="form.period" placeholder="14d"
                /></label>
                <label v-else>Branch<input v-model="form.branch" /></label>
              </div>
              <label v-if="selectedCommand === 'run'"
                >Worktree path<input v-model="form.worktreePath" placeholder="空欄ならCLIの既定値"
              /></label>
              <div class="switches">
                <label class="switch"
                  ><input v-model="form.local" type="checkbox" /><span></span>Local
                  mode（GitHubを呼ばない）</label
                >
                <label class="switch"
                  ><input v-model="form.nonInteractive" type="checkbox" /><span></span
                  >Non-interactive</label
                >
                <label v-if="selectedCommand === 'run'" class="switch"
                  ><input v-model="form.allowInheritedMcp" type="checkbox" /><span></span>Inherited
                  MCP を許可</label
                >
                <label v-if="selectedCommand === 'run'" class="switch"
                  ><input v-model="form.noPush" type="checkbox" /><span></span>Pushしない</label
                >
                <label v-if="selectedCommand === 'run'" class="switch"
                  ><input v-model="form.noPr" type="checkbox" /><span></span>PRを作成しない</label
                >
              </div>
              <button class="run-button" :disabled="running" type="submit">
                <span>{{ running ? "実行中…" : "コマンドを実行" }}</span
                ><b>⌘ ↵</b>
              </button>
              <p v-if="error" class="error-message">{{ error }}</p>
            </form>

            <section class="card output-card">
              <div class="card-heading">
                <div>
                  <span class="step">02</span>
                  <h2>実行ログ</h2>
                </div>
                <span
                  v-if="result"
                  :class="['result', result === '成功' ? 'success' : 'failure']"
                  >{{ result }}</span
                >
              </div>
              <div class="terminal">
                <div v-if="output.length === 0" class="empty-terminal">
                  <span>_</span>
                  <p>実行すると stdout / stderr がここに表示されます</p>
                </div>
                <div
                  v-for="(line, index) in output"
                  :key="index"
                  :class="['log-line', line.stream]"
                >
                  <i>{{ line.stream === "stderr" ? "!" : line.stream === "system" ? "›" : "$" }}</i
                  ><span>{{ line.text }}</span>
                </div>
              </div>
              <div class="artifact-note">
                <span>◈</span>
                <p>
                  成果物と Run 状態は<br /><code>%LOCALAPPDATA%\meguribi\runs</code>
                  に保存されます。
                </p>
              </div>
            </section>
          </div>
        </section>
      </template>

      <template v-else>
        <aside class="sidebar run-sidebar">
          <RunList
            :runs="runSummaries"
            :selected-run-id="selectedRunId"
            :loading="runsLoading"
            :error="runListError"
            @select="selectRun"
          />
        </aside>

        <section class="content run-content">
          <div v-if="runDetail" class="run-detail">
            <div class="page-heading run-page-heading">
              <div>
                <div class="eyebrow">RUN</div>
                <h1>
                  {{ selectedRunTitle }}
                </h1>
                <p>
                  {{ runDetail.state.command }} · {{ runStatusLabel(runDetail.state.status) }} ·
                  {{ runDetail.state.runId }}
                </p>
              </div>
              <span class="badge">{{ runStatusLabel(runDetail.state.status) }}</span>
            </div>
            <p v-if="runStreamError" class="run-stream-error">{{ runStreamError }}</p>
            <RunPipeline :pipeline="runDetail.pipeline" />
            <ActivityBar :activities="runDetail.activities" />
            <section v-if="isConsultationCommand(runDetail.state.command)" class="discussion-area">
              <p v-if="discussionError" class="run-stream-error">{{ discussionError }}</p>
              <p v-else-if="discussionLoading" class="discussion-loading">
                議論を読み込んでいます…
              </p>
              <DiscussionThread ref="discussionThreadRef" :turns="discussionDetail?.turns ?? []" />
              <InterjectBox
                ref="interjectBoxRef"
                :can-interject="discussionDetail?.canInterject ?? false"
                :sending="discussionActionPending === 'say'"
                @submit="submitInterjection"
              />
              <p v-if="interjectionError" class="action-error standalone">
                {{ interjectionError }}
              </p>
              <p v-if="interjectionNotice" class="action-notice standalone">
                {{ interjectionNotice }}
              </p>
              <ConclusionPanel
                :view="conclusionView"
                :approval="discussionDetail?.approval ?? null"
                :can-decide="discussionDetail?.canDecide ?? false"
                :action-pending="discussionActionPending === 'say' ? null : discussionActionPending"
                :action-error="discussionActionError"
                :action-notice="discussionActionNotice"
                @approve="approveCurrentDiscussion"
                @reject="rejectCurrentDiscussion"
                @open-turn="openDiscussionTurn"
              />
            </section>
            <AgentPanes
              :panes="runView.panes"
              :selected-pane="runView.selectedPane"
              @update:selected-pane="setPaneMode"
            />
          </div>
          <div v-else class="empty-terminal empty-run">
            <span>_</span>
            <p>左の一覧から Run を選択すると、工程とライブログが表示されます</p>
          </div>
        </section>
      </template>
    </div>
  </main>
</template>
