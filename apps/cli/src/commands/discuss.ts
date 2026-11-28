import path from "node:path";
import { homedir } from "node:os";
import {
  approveDiscussion,
  continueDiscussToPrAfterApproval,
  createLiveLogRenderer,
  DEFAULT_DISCUSSION_LIMITS,
  hasDiscussToPrContinuation,
  rejectDiscussion,
  runDiscussionWorkflow,
  type DiscussionConclusion,
  type DiscussionDependencies,
  type DiscussionStorePort,
  type DiscussionWorkflowResult,
  type LiveLogMode,
  type LiveLogRenderEvent,
  type RunDiscussionWorkflowInput,
  type RunState,
  type RunStore,
  type WorkflowEvent,
  runConsultation,
  type ApprovalRecord,
} from "@meguribi/core";
import {
  FileSystemDiscussionStore,
  FileSystemRunStore,
  FileSystemWorkflowEventLog,
  hashConclusion,
  ProcessGitCommandRunner,
  redactDiagnosticText,
} from "@meguribi/adapters";
import { parseIssueTarget } from "../target.js";
import {
  createDiscussionDependencies,
  createDiscussToPrDependencies,
  type CreateDiscussionDepsOptions,
  type CreateDiscussToPrDepsOptions,
  type DiscussionWiringDependencies,
} from "../wiring/create-delivery-deps.js";

export interface DiscussCommandOptions {
  repoPath?: string;
  local?: boolean;
  request?: string;
  maxTurns?: string;
  log?: string;
  json?: boolean;
  nonInteractive?: boolean;
  /** Run ごとの参加者上書き（カンマ区切りのプロファイル ID）。永続設定は変更しない。 */
  discussants?: string;
  /** Run ごとの summarizer 上書き（プロファイル ID）。 */
  summarizer?: string;
  /** Issue を持たない read-only 相談のトピック。target 省略時は必須。 */
  prompt?: string;
  /** 議論エージェントの MCP 継承に対するこの Run の明示方針。未指定は従来の fail-closed 判定。 */
  discussionMcpPolicy?: string;
}

/**
 * Run ごとの参加者上書き。redo 時に同じメンバーでやり直すため、
 * RunStore に `discussion-participants.json` として保存する。
 */
export interface ParticipantOverride {
  discussants?: readonly string[];
  summarizer?: string;
}

export function parseParticipantOverride(options: DiscussCommandOptions): ParticipantOverride {
  const override: { discussants?: string[]; summarizer?: string } = {};
  if (options.discussants !== undefined) {
    // サーバー（Command Desk）と同じ検証: 重複を除いた 2〜4 件のプロファイル。
    // 件数・ACP transport・既知プロファイルの検証は配線側で共通に行われる。
    override.discussants = [
      ...new Set(
        options.discussants
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
    ];
  }
  if (options.summarizer !== undefined) {
    override.summarizer = options.summarizer;
  }
  return override;
}

const PARTICIPANT_OVERRIDE_ARTIFACT = "discussion-participants.json";

export async function saveParticipantOverride(
  runStore: RunStore,
  runId: string,
  override: ParticipantOverride,
): Promise<void> {
  if (override.discussants === undefined && override.summarizer === undefined) {
    return;
  }
  await runStore.saveArtifact(runId, PARTICIPANT_OVERRIDE_ARTIFACT, {
    ...(override.discussants !== undefined ? { discussants: [...override.discussants] } : {}),
    ...(override.summarizer !== undefined ? { summarizer: override.summarizer } : {}),
  });
}

async function readParticipantOverride(
  runStore: RunStore,
  runId: string,
): Promise<ParticipantOverride> {
  const value = await runStore.readArtifact<{
    discussants?: readonly string[];
    summarizer?: string;
  }>(runId, PARTICIPANT_OVERRIDE_ARTIFACT);
  if (value === null) {
    return {};
  }
  return {
    ...(Array.isArray(value.discussants) ? { discussants: value.discussants } : {}),
    ...(typeof value.summarizer === "string" ? { summarizer: value.summarizer } : {}),
  };
}

export interface ApproveCommandOptions {
  comment?: string;
}

export interface RejectCommandOptions {
  reason?: string;
  redo?: boolean;
  repoPath?: string;
}

/**
 * `say` が人間の発言を書き込むために必要な inbox 機能を持つ store。
 * `FileSystemDiscussionStore` はこの構造を満たす。
 */
export interface DiscussionInboxStore extends DiscussionStorePort {
  writeHumanMessage(message: string): Promise<string>;
}

type RunWorkflow = typeof runDiscussionWorkflow;
type ApproveWorkflow = typeof approveDiscussion;
type RejectWorkflow = typeof rejectDiscussion;

export interface DiscussionCommandDeps {
  runWorkflow?: RunWorkflow;
  approveWorkflow?: ApproveWorkflow;
  rejectWorkflow?: RejectWorkflow;
  createDependencies?: (
    options: CreateDiscussionDepsOptions,
  ) => Promise<DiscussionWiringDependencies>;
  createDiscussToPrDeps?: (
    options: CreateDiscussToPrDepsOptions,
  ) => ReturnType<typeof createDiscussToPrDependencies>;
  continueWorkflow?: typeof continueDiscussToPrAfterApproval;
  runStore?: RunStore;
  createStore?: (runId: string) => DiscussionInboxStore;
  resolveApprover?: (input: { worktreePath: string }) => Promise<string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => Date;
  cwd?: string;
  abortSignal?: AbortSignal;
}

function localDataRoot(): string {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "meguribi");
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
      "meguribi",
    );
  }
  return path.join(homedir(), ".local", "share", "meguribi");
}

function repositoryPathSegment(repository: string): string {
  return repository.split("/").filter(Boolean).join(path.sep);
}

function defaultWorktreePath(repository: string, issueNumber: number): string {
  return path.join(
    localDataRoot(),
    "worktrees",
    repositoryPathSegment(repository),
    `issue-${String(issueNumber)}`,
  );
}

function invocationArtifactRoot(repository: string, issueNumber: number): string {
  return path.join(
    localDataRoot(),
    "runs",
    repositoryPathSegment(repository),
    `issue-${String(issueNumber)}`,
    `${String(Date.now())}-${String(process.pid)}`,
  );
}

function out(deps: DiscussionCommandDeps, text: string): void {
  (deps.stdout ?? ((value) => process.stdout.write(value)))(text);
}

function err(deps: DiscussionCommandDeps, text: string): void {
  (deps.stderr ?? ((value) => process.stderr.write(value)))(text);
}

/**
 * `--discussion-mcp-policy` の値検証。deny / allow だけを受け付ける。
 * 無効値は fail-closed で exit 1 とし、暗黙の許可に倒れない。
 */
function parseDiscussionMcpPolicy(value: string | undefined): "deny" | "allow" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "deny" || value === "allow") {
    return value;
  }
  throw new Error(`--discussion-mcp-policy must be "deny" or "allow" (got: ${value})`);
}

function parseLogMode(value: string | undefined): LiveLogMode | "none" {
  if (value === undefined) {
    return "stream";
  }
  if (value === "stream" || value === "compact" || value === "none") {
    return value;
  }
  throw new Error(`--log must be one of stream|compact|none, got: ${value}`);
}

function parseMaxTurns(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new Error(`--max-turns must be a positive integer, got: ${value}`);
  }
  return parsed;
}

async function resolveWiring(
  deps: DiscussionCommandDeps,
  options: CreateDiscussionDepsOptions,
): Promise<DiscussionWiringDependencies> {
  const create = deps.createDependencies ?? createDiscussionDependencies;
  return create(options);
}

function resolveRunStore(deps: DiscussionCommandDeps): RunStore {
  // runs の正準ルートは localDataRoot() 直下（status/wiring の resolveRunsRoot と同じ）。
  return deps.runStore ?? new FileSystemRunStore({ rootDir: localDataRoot() });
}

function defaultCreateStore(runStore: RunStore): (runId: string) => DiscussionInboxStore {
  return (runId) => {
    if (runStore instanceof FileSystemRunStore) {
      return new FileSystemDiscussionStore({ runStore, runId });
    }
    throw new Error("createStore must be injected when runStore is not a FileSystemRunStore");
  };
}

/**
 * 相談 Run の repository / remoteIdentity を git origin から引く。
 * remote が無い・解読できない場合は local: パス形式にフォールバックする。
 */
async function resolveConsultationIdentity(
  repositoryPath: string,
): Promise<{ repository: string; remoteIdentity: string }> {
  // remote が無い場合のフォールバック。repository は owner/repo 形状が必須のため
  // local/<basename> とし、remoteIdentity は adapters 倣いの local:<path> 形式。
  const fallback = {
    repository: `local/${path.basename(path.resolve(repositoryPath))}`,
    remoteIdentity: `local:${path.resolve(repositoryPath)}`,
  };
  const runner = new ProcessGitCommandRunner();
  let remote: string;
  try {
    const result = await runner.run(["remote", "get-url", "origin"], repositoryPath);
    if (result.exitCode !== 0) return fallback;
    remote = result.stdout.trim();
    if (remote.length === 0) return fallback;
  } catch {
    return fallback;
  }
  const normalized = normalizeRemoteUrl(remote);
  if (normalized === undefined) return fallback;
  return { repository: normalized.repository, remoteIdentity: normalized.remoteIdentity };
}

/** https/ssh の git URL から host/owner/repo と owner/repo を引く。 */
function normalizeRemoteUrl(
  value: string,
): { repository: string; remoteIdentity: string } | undefined {
  let host: string;
  let pathname: string;
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(value);
  if (ssh !== null) {
    host = ssh[1]!;
    pathname = ssh[2]!;
  } else {
    try {
      const url = new URL(value);
      host = url.hostname;
      pathname = url.pathname.replace(/^\//, "");
    } catch {
      return undefined;
    }
  }
  const cleaned = pathname.replace(/\.git$/, "").replace(/\/+$/, "");
  const segments = cleaned.split("/").filter((part) => part.length > 0);
  if (segments.length < 2) return undefined;
  const repository = `${segments[segments.length - 2]!}/${segments[segments.length - 1]!}`;
  return {
    repository,
    remoteIdentity: `${host.toLowerCase()}/${cleaned}`.toLowerCase(),
  };
}

/**
 * 承認者は仕様書 §6.3 のとおりローカルの git user。
 * 対象リポジトリ（Run の worktree）で `git config user.name` を引く。
 */
async function defaultResolveApprover(input: {
  worktreePath: string;
}): Promise<string | undefined> {
  const runner = new ProcessGitCommandRunner();
  try {
    const result = await runner.run(["config", "user.name"], input.worktreePath);
    if (result.exitCode === 0) {
      const name = result.stdout.trim();
      if (name.length > 0) {
        return name;
      }
    }
  } catch {
    // worktree が無い・git ではない場合は未解決として扱う。
  }
  return undefined;
}

const APPROVER_GUIDANCE =
  "git user.name を解決できません（承認者の記録に必要です）。\n" +
  "対象リポジトリで `git config user.name \"Your Name\"` を設定するか、" +
  "`git config --global user.name \"Your Name\"` を設定してください\n";

async function approverForRun(
  runStore: RunStore,
  runId: string,
  deps: DiscussionCommandDeps,
): Promise<{ approver: string } | { error: string }> {
  const state = await runStore.load(runId);
  if (state === null) {
    return { error: `Run が見つかりません: ${runId}\n` };
  }
  const resolve = deps.resolveApprover ?? defaultResolveApprover;
  const approver = await resolve({ worktreePath: state.worktreePath });
  if (approver === undefined || approver.trim().length === 0) {
    return { error: APPROVER_GUIDANCE };
  }
  return { approver };
}

/**
 * `discuss` 実行時に T7 が保存する `discussion-input.json` のうち、
 * redo の配線に必要な項目。全体の復元は T7（requireRedoInput）が行う。
 */
interface PersistedDiscussionInput {
  repositoryPath: string;
  baseRef: string;
  nonInteractive: boolean;
}

async function readPersistedDiscussionInput(
  runStore: RunStore,
  runId: string,
): Promise<PersistedDiscussionInput | null> {
  const value = await runStore.readArtifact<unknown>(runId, "discussion-input.json");
  if (value === null || typeof value !== "object") {
    return null;
  }
  const input = value as Partial<PersistedDiscussionInput>;
  if (
    typeof input.repositoryPath !== "string" ||
    typeof input.baseRef !== "string" ||
    typeof input.nonInteractive !== "boolean"
  ) {
    return null;
  }
  return {
    repositoryPath: input.repositoryPath,
    baseRef: input.baseRef,
    nonInteractive: input.nonInteractive,
  };
}

function createRenderer(
  stderr: (text: string) => void,
  options: { mode: LiveLogMode; color: boolean },
): { observe: (event: LiveLogRenderEvent) => void; flush: () => void } {
  const renderer = createLiveLogRenderer({
    mode: options.mode,
    color: options.color,
    redact: redactDiagnosticText,
  });
  return {
    observe: (event) => {
      const rendered = renderer.render(event);
      if (rendered.length > 0) {
        stderr(rendered);
      }
    },
    flush: () => {
      const rendered = renderer.flush();
      if (rendered.length > 0) {
        stderr(rendered);
      }
    },
  };
}

function liveLogColor(): boolean {
  return process.stderr.isTTY === true && process.env.NO_COLOR === undefined;
}

function isLiveLogRenderEvent(event: WorkflowEvent): event is WorkflowEvent & LiveLogRenderEvent {
  return (
    event.type === "step.started" ||
    event.type === "agent.event" ||
    event.type === "step.progress" ||
    event.type === "discussion.turn" ||
    event.type === "discussion.ended"
  );
}

/**
 * runId は workflow 内部で発行されるため、events.jsonl への永続化は
 * runId が分かるまでメモリに buffer する（run.ts と同じ方式）。
 */
function createEventPipeline(input: {
  runStore: RunStore;
  stderr: (text: string) => void;
  renderer?: { observe: (event: LiveLogRenderEvent) => void };
}): {
  onWorkflowEvent: (event: WorkflowEvent) => void;
  captureRunId: (runId: string) => void;
  flush: () => Promise<void>;
} {
  const { runStore, stderr, renderer } = input;
  const buffered: WorkflowEvent[] = [];
  let runId: string | undefined;
  let queue: Promise<void> = Promise.resolve();
  let warningWritten = false;
  let renderWarningWritten = false;

  const eventLog =
    runStore instanceof FileSystemRunStore
      ? new FileSystemWorkflowEventLog({ runStore })
      : undefined;

  const warnOnce = (error: unknown): void => {
    if (warningWritten) return;
    warningWritten = true;
    const message = error instanceof Error ? error.message : String(error);
    stderr(
      `warning: failed to append workflow event to events.jsonl; discussion result is unaffected (${redactDiagnosticText(message)})\n`,
    );
  };

  const persistEvent = (event: WorkflowEvent): void => {
    if (eventLog === undefined) {
      return;
    }
    if (runId === undefined) {
      buffered.push(event);
      return;
    }
    const targetRunId = runId;
    queue = queue.then(async () => {
      try {
        await eventLog.append(targetRunId, event);
      } catch (error) {
        warnOnce(error);
      }
    });
  };

  const renderEvent = (event: WorkflowEvent): void => {
    if (!isLiveLogRenderEvent(event)) {
      return;
    }
    try {
      renderer?.observe(event);
    } catch (error) {
      if (!renderWarningWritten) {
        renderWarningWritten = true;
        const message = error instanceof Error ? error.message : String(error);
        stderr(
          `warning: failed to render live-log event; discussion result is unaffected (${redactDiagnosticText(message)})\n`,
        );
      }
    }
  };

  return {
    onWorkflowEvent(event) {
      persistEvent(event);
      renderEvent(event);
    },
    captureRunId(nextRunId) {
      if (runId !== undefined) return;
      runId = nextRunId;
      for (const event of buffered.splice(0)) {
        persistEvent(event);
      }
    },
    flush: async () => {
      await queue;
    },
  };
}

function formatConclusion(conclusion: DiscussionConclusion): string {
  const lines: string[] = [];
  lines.push(`結論: ${conclusion.conclusion}\n`);
  if (conclusion.issues.length > 0) {
    lines.push("\n論点ごとの立場:\n");
    for (const issue of conclusion.issues) {
      lines.push(`- ${issue.issue}\n`);
      for (const position of issue.positions) {
        lines.push(`  - ${position.participant}: ${position.stance}\n`);
      }
      lines.push(`  解決: ${issue.resolution}\n`);
    }
  }
  if (conclusion.rejectedOptions.length > 0) {
    lines.push("\n却下された選択肢:\n");
    for (const option of conclusion.rejectedOptions) {
      lines.push(`- ${option.option}: ${option.reason}\n`);
    }
  }
  return lines.join("");
}

function formatNext(runId: string): string {
  return (
    `\nNext: meguribi approve ${runId}` +
    `  /  meguribi reject ${runId} --reason "..." [--redo]\n`
  );
}

function successStatus(status: RunState["status"]): boolean {
  return status === "awaiting_human" || status === "completed";
}

/**
 * Issue を持たない prompt 単独の read-only 相談を実行する。
 * GitHub Issue・ラベル・承認記録・delivery 継続設定を一切作らず、
 * 結論の保存だけを行う。実装・PR へ進む経路は存在しない。
 */
async function runConsultationCommand(
  options: DiscussCommandOptions,
  deps: DiscussionCommandDeps,
): Promise<{ exitCode: number }> {
  const topic = options.prompt?.trim() ?? "";
  if (topic.length === 0) {
    err(deps, "target を省略した相談には --prompt が必要です\n");
    return { exitCode: 1 };
  }
  const mode = parseLogMode(options.log);
  const maxTurns = parseMaxTurns(options.maxTurns);
  const cwd = deps.cwd ?? process.cwd();
  const repositoryPath = options.repoPath ?? cwd;
  const nonInteractive = options.nonInteractive ?? false;

  const renderer =
    mode === "none" || options.json === true
      ? undefined
      : createRenderer((text) => err(deps, text), { mode, color: liveLogColor() });

  const participantOverride = parseParticipantOverride(options);
  let mcpPolicy: "deny" | "allow" | undefined;
  try {
    mcpPolicy = parseDiscussionMcpPolicy(options.discussionMcpPolicy);
  } catch (error) {
    err(deps, `${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1 };
  }
  const wiring = await resolveWiring(deps, {
    cwd,
    repositoryPath,
    nonInteractive,
    localOnly: options.local,
    ...(participantOverride.discussants !== undefined
      ? { discussants: participantOverride.discussants }
      : {}),
    ...(participantOverride.summarizer !== undefined
      ? { summarizer: participantOverride.summarizer }
      : {}),
    ...(mcpPolicy !== undefined ? { discussionMcpPolicy: mcpPolicy } : {}),
  });

  // D 確定契約: command "consult"、issueNumber/branch/baseRef/baseSha/headSha は null。
  // GitHub 上の Issue やブランチ・worktree は一切作らない。
  const identity = await resolveConsultationIdentity(repositoryPath);
  const state = await wiring.runStore.create({
    repository: identity.repository,
    command: "consult",
    consultation: {
      worktreePath: repositoryPath,
      remoteIdentity: identity.remoteIdentity,
    },
    maxFixAttempts: 0,
  });

  const pipeline = createEventPipeline({
    runStore: wiring.runStore,
    stderr: (text) => err(deps, text),
    ...(renderer === undefined ? {} : { renderer }),
  });
  pipeline.captureRunId(state.runId);
  // サーバー開始プロトコル: Run 作成直後に永続 Run ID を stdout へ早期報告する。
  // --json では stdout を純 JSON に保つため出力しない。
  if (options.json !== true) {
    out(deps, `Run ID: ${state.runId}\n`);
  }

  const artifactRoot = path.join(localDataRoot(), "consultations", state.runId);
  const store = wiring.createStore(state.runId);
  try {
    const result = await runConsultation({
      runId: state.runId,
      cwd: repositoryPath,
      artifactRoot,
      topic,
      ...(options.request !== undefined ? { userRequest: options.request } : {}),
      limits: {
        ...DEFAULT_DISCUSSION_LIMITS,
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      },
      store,
      onEvent: pipeline.onWorkflowEvent,
      ...(deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {}),
    }, {
      discussants: wiring.discussants,
      summarizer: wiring.summarizer,
      parseEnvelope: wiring.parseEnvelope,
      summarize: wiring.summarize,
      now: deps.now ?? (() => new Date()),
    });

    await wiring.runStore.update(state.runId, { status: "completed" });
    await saveParticipantOverride(wiring.runStore, state.runId, participantOverride).catch(() => undefined);
    renderer?.flush();
    await pipeline.flush();

    if (options.json === true) {
      out(deps, `${JSON.stringify({ runId: state.runId, status: "completed", conclusion: result.conclusion }, null, 2)}\n`);
    } else {
      out(deps, formatConclusion(result.conclusion));
      out(deps, `相談は完了しました: ${state.runId}\n`);
    }
    return { exitCode: 0 };
  } catch (error) {
    await wiring.runStore.update(state.runId, { status: "failed" }).catch(() => undefined);
    renderer?.flush();
    await pipeline.flush().catch(() => undefined);
    throw error;
  }
}

export async function runDiscussCommand(
  target: string | undefined,
  options: DiscussCommandOptions,
  deps: DiscussionCommandDeps = {},
): Promise<{ exitCode: number }> {
  if (target === undefined) {
    return runConsultationCommand(options, deps);
  }
  if (options.prompt !== undefined) {
    err(deps, "--prompt は target 省略時だけ指定してください。Issue への追記は --request を使います\n");
    return { exitCode: 1 };
  }
  const mode = parseLogMode(options.log);
  const maxTurns = parseMaxTurns(options.maxTurns);
  const parsed = parseIssueTarget(target);
  const cwd = deps.cwd ?? process.cwd();
  const repositoryPath = options.repoPath ?? cwd;
  const nonInteractive = options.nonInteractive ?? false;

  const renderer =
    mode === "none" || options.json === true
      ? undefined
      : createRenderer((text) => err(deps, text), { mode, color: liveLogColor() });

  const participantOverride = parseParticipantOverride(options);
  let mcpPolicy: "deny" | "allow" | undefined;
  try {
    mcpPolicy = parseDiscussionMcpPolicy(options.discussionMcpPolicy);
  } catch (error) {
    err(deps, `${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1 };
  }
  const wiring = await resolveWiring(deps, {
    cwd,
    repositoryPath,
    repository: parsed.repository,
    nonInteractive,
    localOnly: options.local,
    ...(participantOverride.discussants !== undefined
      ? { discussants: participantOverride.discussants }
      : {}),
    ...(participantOverride.summarizer !== undefined
      ? { summarizer: participantOverride.summarizer }
      : {}),
    ...(mcpPolicy !== undefined ? { discussionMcpPolicy: mcpPolicy } : {}),
  });
  const runWorkflow = deps.runWorkflow ?? runDiscussionWorkflow;

  const pipeline = createEventPipeline({
    runStore: wiring.runStore,
    stderr: (text) => err(deps, text),
    ...(renderer === undefined ? {} : { renderer }),
  });
  let runIdReported = false;

  const input: RunDiscussionWorkflowInput = {
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
    repositoryPath,
    worktreePath: defaultWorktreePath(parsed.repository, parsed.issueNumber),
    branch: `meguribi/issue-${String(parsed.issueNumber)}`,
    baseRef: options.local ? "HEAD" : "origin/main",
    requiredLabels: ["agent:ready"],
    repositoryRules: "Follow AGENTS.md",
    ...(options.request !== undefined ? { userRequest: options.request } : {}),
    limits: {
      ...DEFAULT_DISCUSSION_LIMITS,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    },
    nonInteractive,
    artifactRoot: invocationArtifactRoot(parsed.repository, parsed.issueNumber),
    ...(deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {}),
  };

  const workflowDeps: DiscussionDependencies = {
    ...wiring,
    onWorkflowEvent: pipeline.onWorkflowEvent,
    onStateChange: (state) => {
      // サーバー開始プロトコル: Run 作成直後に永続 Run ID を stdout へ早期報告する。
      // --json では stdout を純 JSON に保つため出力しない。
      if (!runIdReported && options.json !== true) {
        runIdReported = true;
        out(deps, `Run ID: ${state.runId}\n`);
      }
      pipeline.captureRunId(state.runId);
    },
    now: deps.now ?? (() => new Date()),
  };

  const result: DiscussionWorkflowResult = await runWorkflow(input, workflowDeps);
  // 参加者 override は redo で同じメンバーを復元するため Run に保存する。
  await saveParticipantOverride(wiring.runStore, result.runId, participantOverride).catch(() => undefined);
  // state change が一度も無くても、結果の runId で buffer を flush できるようにする。
  pipeline.captureRunId(result.runId);
  renderer?.flush();
  await pipeline.flush();

  if (options.json === true) {
    out(deps, `${JSON.stringify(result, null, 2)}\n`);
  } else if (result.status === "awaiting_human") {
    if (result.conclusion !== undefined) {
      out(deps, formatConclusion(result.conclusion));
    }
    out(deps, formatNext(result.runId));
  } else if (result.status === "completed") {
    out(deps, `議論は完了しました: ${result.runId}\n`);
  } else {
    err(deps, `議論は ${result.status} で終了しました: ${result.runId}\n`);
    for (const reason of result.reasons) {
      err(deps, `- ${reason}\n`);
    }
  }

  return { exitCode: successStatus(result.status) ? 0 : 1 };
}

// say が書けるのは議論が進行している `created` の間だけ。
// 結論が出た後（awaiting_human 以降）は inbox を消費するセッションが存在しない。
const SAY_ALLOWED_STATUSES = new Set<RunState["status"]>(["created"]);

export async function runSayCommand(
  runId: string,
  message: string,
  deps: DiscussionCommandDeps = {},
): Promise<{ exitCode: number }> {
  if (message.trim().length === 0) {
    err(deps, "message must not be empty\n");
    return { exitCode: 1 };
  }
  const runStore = resolveRunStore(deps);
  const state = await runStore.load(runId);
  if (state === null) {
    err(deps, `Run が見つかりません: ${runId}\n`);
    return { exitCode: 1 };
  }
  if (state.command !== "discuss" && state.command !== "consult") {
    err(deps, `Run ${runId} は議論の Run ではありません (command: ${state.command})\n`);
    return { exitCode: 1 };
  }
  if (!SAY_ALLOWED_STATUSES.has(state.status)) {
    err(deps, `Run ${runId} は議論中ではありません (status: ${state.status})\n`);
    return { exitCode: 1 };
  }

  const createStore = deps.createStore ?? defaultCreateStore(runStore);
  const store = createStore(runId);
  await store.writeHumanMessage(message);
  out(deps, `Run ${runId} に発言を書き込みました\n`);
  return { exitCode: 0 };
}

/**
 * 継続再試行で再利用できるのは「現在の結論への有効な承認」だけ。
 * decision が approved で、conclusionHash が現在の結論ハッシュと一致する場合に限る。
 * rejected レコードや、承認後に結論が変わった（redo 後の新結論を含む）レコードは
 * 再利用せず、人間の明示的な新規承認を必ず記録する。
 */
async function isReusableApproval(
  runStore: RunStore,
  deps: DiscussionCommandDeps,
  runId: string,
  approval: ApprovalRecord | null,
): Promise<boolean> {
  if (approval === null || approval.decision !== "approved") {
    return false;
  }
  const store = (deps.createStore ?? defaultCreateStore(runStore))(runId);
  const conclusion = await store.readConclusion();
  if (conclusion === null) {
    return false;
  }
  return hashConclusion(conclusion) === approval.conclusionHash;
}

function approvalDeps(
  runStore: RunStore,
  deps: DiscussionCommandDeps,
): Pick<DiscussionDependencies, "runStore" | "createStore" | "hashConclusion" | "now"> {
  return {
    runStore,
    createStore: deps.createStore ?? defaultCreateStore(runStore),
    hashConclusion,
    now: deps.now ?? (() => new Date()),
  };
}

export async function runApproveCommand(
  runId: string,
  options: ApproveCommandOptions,
  deps: DiscussionCommandDeps = {},
): Promise<{ exitCode: number }> {
  const runStore = resolveRunStore(deps);
  const approve = deps.approveWorkflow ?? approveDiscussion;
  const resolved = await approverForRun(runStore, runId, deps);
  if ("error" in resolved) {
    err(deps, resolved.error);
    return { exitCode: 1 };
  }

  // discuss-to-pr の Run かどうかで分岐する。
  // 対象なら承認記録のあと、そのプロセスで specify 以降の継続実行へ進む（設計書 §6.5）。
  const isDiscussToPr = await hasDiscussToPrContinuation(runStore, runId);
  const existingApproval = isDiscussToPr
    ? await runStore.readArtifact<ApprovalRecord>(runId, "approval.json")
    : null;
  // rejected レコードやハッシュの合わないレコードでは承認をスキップしない。
  // スキップできるのは現在の結論への有効な承認が既にある場合だけ。
  const reusable = isDiscussToPr
    ? await isReusableApproval(runStore, deps, runId, existingApproval)
    : false;

  if (!reusable) {
    const result = await approve(
      {
        runId,
        approver: resolved.approver,
        ...(options.comment !== undefined ? { comment: options.comment } : {}),
      },
      approvalDeps(runStore, deps),
    );
    if (result.status !== "completed") {
      err(deps, `承認できませんでした (status: ${result.status})\n`);
      for (const reason of result.reasons) {
        err(deps, `- ${reason}\n`);
      }
      return { exitCode: 1 };
    }
    out(deps, `Run ${runId} の結論を承認しました\n`);
  } else {
    // 継続が途中失敗したあとの再入口: 現在の結論への有効な承認は記録済みなので
    // 二重記録せず継続だけ行う。ハッシュの書き換えは行わない。
    out(deps, `Run ${runId} の承認は記録済みです。継続を再開します\n`);
  }

  if (!isDiscussToPr) {
    return { exitCode: 0 };
  }

  return continueDiscussToPrRun(runId, runStore, deps);
}

/**
 * discuss-to-pr Run の継続実行。
 * wiring は caller の cwd ではなく保存済み discussion-input.json の値で復元する
 * （別 cwd から approve しても同じ依存ができる）。
 */
async function continueDiscussToPrRun(
  runId: string,
  runStore: RunStore,
  deps: DiscussionCommandDeps,
): Promise<{ exitCode: number }> {
  const cwd = deps.cwd ?? process.cwd();
  const persisted = await readPersistedDiscussionInput(runStore, runId);
  const repositoryPath = persisted?.repositoryPath ?? cwd;
  const create = deps.createDiscussToPrDeps ?? createDiscussToPrDependencies;
  const wiring = await create({
    cwd,
    repositoryPath,
    localOnly: persisted === null ? undefined : persisted.baseRef === "HEAD",
    nonInteractive: persisted?.nonInteractive ?? false,
  });
  const continueWorkflow = deps.continueWorkflow ?? continueDiscussToPrAfterApproval;
  const result = await continueWorkflow(
    {
      runId,
      ...(deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {}),
    },
    wiring.deps,
  );
  if (result.published) {
    const pr = result.pullRequestNumber !== undefined ? ` (Draft PR: #${String(result.pullRequestNumber)})` : "";
    out(deps, `specify 以降が完了し、公開まで進みました${pr}\n`);
    return { exitCode: 0 };
  }
  err(deps, `継続は ${result.status} で終了しました。復旧後に meguribi approve ${runId} で再開できます\n`);
  for (const reason of result.reasons) {
    err(deps, `- ${reason}\n`);
  }
  return { exitCode: 1 };
}

export async function runRejectCommand(
  runId: string,
  options: RejectCommandOptions,
  deps: DiscussionCommandDeps = {},
): Promise<{ exitCode: number }> {
  const reason = options.reason ?? "";
  if (reason.trim().length === 0) {
    err(deps, "--reason は必須です: meguribi reject <runId> --reason \"...\" [--redo]\n");
    return { exitCode: 1 };
  }
  const redo = options.redo ?? false;
  const runStore = resolveRunStore(deps);
  const reject = deps.rejectWorkflow ?? rejectDiscussion;
  const resolved = await approverForRun(runStore, runId, deps);
  if ("error" in resolved) {
    err(deps, resolved.error);
    return { exitCode: 1 };
  }
  const baseDeps = approvalDeps(runStore, deps);

  let workflowDeps: DiscussionDependencies;
  let redoInput: Partial<RunDiscussionWorkflowInput> = {};
  let renderer: ReturnType<typeof createRenderer> | undefined;
  let pipeline: ReturnType<typeof createEventPipeline> | undefined;
  if (redo) {
    // redo では議論をやり直すため、エージェントを含む完全な依存が必要。
    // 依存の生成には cwd ではなく、元の discuss が保存した discussion-input.json を
    // wiring 前に読んで使う（別の cwd から実行しても同じ依存ができる）。
    const cwd = deps.cwd ?? process.cwd();
    const persisted = await readPersistedDiscussionInput(runStore, runId);
    const repositoryPath = options.repoPath ?? persisted?.repositoryPath ?? cwd;
    // redo は同じ参加者・要約でやり直す。override は永続設定ではなく Run に保存したものを使う。
    const participants = await readParticipantOverride(runStore, runId);
    const wiring = await resolveWiring(deps, {
      cwd,
      repositoryPath,
      // baseRef が HEAD になるのは --local で開始された議論だけ。
      localOnly: persisted === null ? undefined : persisted.baseRef === "HEAD",
      nonInteractive: persisted?.nonInteractive ?? false,
      ...(participants.discussants !== undefined ? { discussants: participants.discussants } : {}),
      ...(participants.summarizer !== undefined ? { summarizer: participants.summarizer } : {}),
    });
    renderer = createRenderer((text) => err(deps, text), {
      mode: "stream",
      color: liveLogColor(),
    });
    const redoPipeline = createEventPipeline({
      runStore,
      stderr: (text) => err(deps, text),
      renderer,
    });
    pipeline = redoPipeline;
    redoPipeline.captureRunId(runId);
    workflowDeps = {
      ...wiring,
      ...baseDeps,
      onWorkflowEvent: redoPipeline.onWorkflowEvent,
      onStateChange: (state) => {
        redoPipeline.captureRunId(state.runId);
      },
    };
    // 入力の復元は T7（requireRedoInput）が discussion-input.json から行う。
    // CLI から値を渡すと保存済みの正しい値を上書きしてしまうため、
    // 永続化されない abortSignal だけを渡す。
    redoInput =
      deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {};
  } else {
    workflowDeps = baseDeps as DiscussionDependencies;
  }

  const result = await reject(
    { runId, approver: resolved.approver, reason, redo, ...redoInput },
    workflowDeps,
  );
  if (pipeline !== undefined) {
    pipeline.captureRunId(result.runId);
  }
  renderer?.flush();
  await pipeline?.flush();
  if (result.status === "completed" || result.status === "awaiting_human" || result.status === "created") {
    out(
      deps,
      redo
        ? `Run ${runId} を却下し、議論をやり直します\n`
        : `Run ${runId} を却下しました\n`,
    );
    if (redo && result.status === "awaiting_human") {
      if (result.conclusion !== undefined) {
        out(deps, formatConclusion(result.conclusion));
      }
      out(deps, formatNext(result.runId));
    }
    return { exitCode: 0 };
  }
  err(deps, `却下できませんでした (status: ${result.status})\n`);
  for (const failure of result.reasons) {
    err(deps, `- ${failure}\n`);
  }
  return { exitCode: 1 };
}
