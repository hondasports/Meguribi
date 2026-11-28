import path from "node:path";
import { homedir } from "node:os";
import {
  approveDiscussion,
  createLiveLogRenderer,
  DEFAULT_DISCUSSION_LIMITS,
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
  type CreateDiscussionDepsOptions,
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

export async function runDiscussCommand(
  target: string,
  options: DiscussCommandOptions,
  deps: DiscussionCommandDeps = {},
): Promise<{ exitCode: number }> {
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

  const wiring = await resolveWiring(deps, {
    cwd,
    repositoryPath,
    repository: parsed.repository,
    nonInteractive,
    localOnly: options.local,
  });
  const runWorkflow = deps.runWorkflow ?? runDiscussionWorkflow;

  const pipeline = createEventPipeline({
    runStore: wiring.runStore,
    stderr: (text) => err(deps, text),
    ...(renderer === undefined ? {} : { renderer }),
  });

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
      pipeline.captureRunId(state.runId);
    },
    now: deps.now ?? (() => new Date()),
  };

  const result: DiscussionWorkflowResult = await runWorkflow(input, workflowDeps);
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
  if (state.command !== "discuss") {
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
  const result = await approve(
    {
      runId,
      approver: resolved.approver,
      ...(options.comment !== undefined ? { comment: options.comment } : {}),
    },
    approvalDeps(runStore, deps),
  );
  if (result.status === "completed") {
    out(deps, `Run ${runId} の結論を承認しました\n`);
    return { exitCode: 0 };
  }
  err(deps, `承認できませんでした (status: ${result.status})\n`);
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
  if (redo) {
    // redo では議論をやり直すため、エージェントを含む完全な依存と再開入力が必要。
    const cwd = deps.cwd ?? process.cwd();
    const wiring = await resolveWiring(deps, {
      cwd,
      repositoryPath: options.repoPath ?? cwd,
      nonInteractive: false,
    });
    workflowDeps = { ...wiring, ...baseDeps };
    const state = await runStore.load(runId);
    redoInput = {
      repositoryPath: options.repoPath ?? cwd,
      repositoryRules: "Follow AGENTS.md",
      limits: { ...DEFAULT_DISCUSSION_LIMITS },
      artifactRoot: state === null
        ? invocationArtifactRoot("unknown", 0)
        : invocationArtifactRoot(state.repository, state.issueNumber),
      ...(deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {}),
    };
  } else {
    workflowDeps = baseDeps as DiscussionDependencies;
  }

  const result = await reject(
    { runId, approver: resolved.approver, reason, redo, ...redoInput },
    workflowDeps,
  );
  if (result.status === "completed" || result.status === "awaiting_human" || result.status === "created") {
    out(
      deps,
      redo
        ? `Run ${runId} を却下し、議論をやり直します\n`
        : `Run ${runId} を却下しました\n`,
    );
    return { exitCode: 0 };
  }
  err(deps, `却下できませんでした (status: ${result.status})\n`);
  for (const failure of result.reasons) {
    err(deps, `- ${failure}\n`);
  }
  return { exitCode: 1 };
}
