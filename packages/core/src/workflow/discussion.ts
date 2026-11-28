import type {
  IssueRecord,
  IssueRunState,
  RunState,
  RunStatus,
  RunStore,
} from "../delivery.js";
import { ApprovalError, type ApprovalRecord } from "../discussion/approval.js";
import type { DiscussionBrief } from "../discussion/prompt.js";
import type { DiscussionStorePort } from "../discussion/ports.js";
import type { DiscussionConclusion, DiscussionLimits } from "../discussion/types.js";
import { agentDisplayName } from "../role-agent.js";
import { runWorkflow, type WorkflowRunResult } from "../workflow-engine/engine.js";
import { createRunStoreStepStateStore } from "../workflow-engine/run-store-step-state.js";
import { createDiscussionWorkflow } from "./discussion-definition.js";
import { requireIssueRunState } from "../delivery.js";
import {
  createDiscussionStepHandlers,
  updateDiscussionRunState,
  type DiscussionDependencies,
  type DiscussionWorkflowContext,
  type DiscussionWorkflowResult,
  type RunDiscussionWorkflowInput,
} from "./discussion-steps.js";

export { createDiscussionWorkflow } from "./discussion-definition.js";
export type {
  DiscussionDependencies,
  DiscussionWorkflowResult,
  RunDiscussionWorkflowInput,
} from "./discussion-steps.js";

export type RejectDiscussionInput = {
  runId: string;
  approver: string;
  reason: string;
  redo: boolean;
} & Partial<RunDiscussionWorkflowInput>;

interface DiscussionInputArtifact {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  requiredLabels: readonly string[];
  repositoryRules: string;
  userRequest?: string;
  limits: DiscussionLimits;
  nonInteractive: boolean;
  artifactRoot: string;
}

function nowIso(deps: Pick<DiscussionDependencies, "now">): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

async function notifyStateChange(
  deps: Pick<DiscussionDependencies, "onStateChange">,
  state: RunState,
): Promise<void> {
  try {
    await deps.onStateChange?.(state);
  } catch {
    return;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "unknown";
}

function statusForError(error: unknown): RunStatus {
  const code = errorCode(error);
  if (code === "cancelled") return "cancelled";
  if (code === "timeout") return "timed_out";
  if (code === "policy_blocked" || code === "permission_denied") return "blocked";
  return "failed";
}

function createBrief(
  runId: string,
  input: RunDiscussionWorkflowInput,
  issue: IssueRecord,
  deps: DiscussionDependencies,
  redoNotes: readonly string[],
): DiscussionBrief {
  return {
    runId,
    topic: issue.title,
    issueBody: issue.body,
    comments: issue.comments.map((comment) => comment.body),
    ...(input.userRequest === undefined ? {} : { userRequest: input.userRequest }),
    repositoryRules: input.repositoryRules,
    participants: deps.discussants.map((agent) => ({
      id: agent.profileId,
      label: agentDisplayName(agent.kind),
    })),
    redoNotes: [...redoNotes],
  };
}

async function executeDiscussionWorkflow(
  input: RunDiscussionWorkflowInput,
  deps: DiscussionDependencies,
  state: IssueRunState,
  issue: IssueRecord,
  store: DiscussionStorePort,
  brief: DiscussionBrief,
  options: { startAt?: string; turnIdOffset?: number } = {},
): Promise<DiscussionWorkflowResult> {
  const context: DiscussionWorkflowContext = {
    deps,
    input,
    state,
    issue,
    brief,
    store,
    turns: [],
    turnIdOffset: options.turnIdOffset ?? 0,
  };
  const workflowResult: WorkflowRunResult<DiscussionWorkflowResult> = await runWorkflow({
    runId: state.runId,
    definition: createDiscussionWorkflow(),
    handlers: createDiscussionStepHandlers(),
    context,
    ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
    stepStore: createRunStoreStepStateStore(deps.runStore, state.runId),
    onEvent: deps.onWorkflowEvent,
    now: deps.now,
  });
  if (workflowResult.type === "stopped") {
    return workflowResult.result;
  }
  throw new Error(`discussion workflow ended without a result: ${workflowResult.type}`);
}

async function executeDiscussionWorkflowWithFailureResult(
  input: RunDiscussionWorkflowInput,
  deps: DiscussionDependencies,
  state: IssueRunState,
  issue: IssueRecord,
  store: DiscussionStorePort,
  brief: DiscussionBrief,
  options: { startAt?: string; turnIdOffset?: number } = {},
): Promise<DiscussionWorkflowResult> {
  try {
    return await executeDiscussionWorkflow(input, deps, state, issue, store, brief, options);
  } catch (error) {
    const status = statusForError(error);
    const message = errorMessage(error);
    await updateDiscussionRunState(deps, state.runId, {
      status,
      lastError: {
        code: errorCode(error),
        message,
      },
    }).catch(() => undefined);
    return {
      runId: state.runId,
      status,
      reasons: [message],
    };
  }
}

function discussionInputArtifact(input: RunDiscussionWorkflowInput): DiscussionInputArtifact {
  return {
    repositoryPath: input.repositoryPath,
    worktreePath: input.worktreePath,
    branch: input.branch,
    baseRef: input.baseRef,
    requiredLabels: [...input.requiredLabels],
    repositoryRules: input.repositoryRules,
    ...(input.userRequest === undefined ? {} : { userRequest: input.userRequest }),
    limits: { ...input.limits },
    nonInteractive: input.nonInteractive,
    artifactRoot: input.artifactRoot,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDiscussionLimits(value: unknown): value is DiscussionLimits {
  if (!value || typeof value !== "object") {
    return false;
  }
  const limits = value as Partial<DiscussionLimits>;
  return (
    typeof limits.maxTurns === "number" &&
    typeof limits.maxDurationMs === "number" &&
    typeof limits.turnTimeoutMs === "number" &&
    limits.maxTurns > 0 &&
    limits.maxDurationMs > 0 &&
    limits.turnTimeoutMs > 0
  );
}

function isDiscussionInputArtifact(value: unknown): value is DiscussionInputArtifact {
  if (!value || typeof value !== "object") {
    return false;
  }
  const input = value as Partial<DiscussionInputArtifact>;
  return (
    typeof input.repositoryPath === "string" &&
    typeof input.worktreePath === "string" &&
    typeof input.branch === "string" &&
    typeof input.baseRef === "string" &&
    isStringArray(input.requiredLabels) &&
    typeof input.repositoryRules === "string" &&
    (input.userRequest === undefined || typeof input.userRequest === "string") &&
    isDiscussionLimits(input.limits) &&
    typeof input.nonInteractive === "boolean" &&
    typeof input.artifactRoot === "string"
  );
}

async function readDiscussionInputArtifact(
  runStore: RunStore,
  runId: string,
): Promise<DiscussionInputArtifact | null> {
  const value = await runStore.readArtifact<unknown>(runId, "discussion-input.json");
  if (value === null) {
    return null;
  }
  if (!isDiscussionInputArtifact(value)) {
    throw new Error("Invalid discussion-input.json artifact");
  }
  return value;
}

export async function runDiscussionWorkflow(
  input: RunDiscussionWorkflowInput,
  deps: DiscussionDependencies,
): Promise<DiscussionWorkflowResult> {
  const issue = await deps.github.getIssue(input.repository, input.issueNumber);
  await deps.policy.assertReady({
    labels: issue.labels,
    requiredLabels: input.requiredLabels,
    nonInteractive: input.nonInteractive,
  });
  const worktree = await deps.git.ensureWorktree({
    repositoryPath: input.repositoryPath,
    worktreePath: input.worktreePath,
    branch: input.branch,
    baseRef: input.baseRef,
  });
  const state = requireIssueRunState(await deps.runStore.create({
    repository: input.repository,
    issueNumber: input.issueNumber,
    command: "discuss",
    identity: {
      repository: input.repository,
      issueNumber: input.issueNumber,
      branch: input.branch,
      worktreePath: input.worktreePath,
      baseRef: input.baseRef,
      baseSha: worktree.baseSha,
      headSha: worktree.headSha,
      remoteIdentity: worktree.remoteIdentity,
    },
    maxFixAttempts: 0,
  }));
  await deps.runStore.acquireLock({
    repository: input.repository,
    issueNumber: input.issueNumber,
    runId: state.runId,
  });

  try {
    await notifyStateChange(deps, state);
    await deps.runStore.saveArtifact(state.runId, "discussion-input.json", discussionInputArtifact(input));
    const store = deps.createStore(state.runId);
    const brief = createBrief(state.runId, input, issue, deps, []);
    return await executeDiscussionWorkflowWithFailureResult(input, deps, state, issue, store, brief);
  } finally {
    await deps.runStore
      .releaseLock({
        repository: input.repository,
        issueNumber: input.issueNumber,
      })
      .catch(() => undefined);
  }
}

function assertAwaitingApproval(state: RunState | null, runId: string): asserts state is IssueRunState {
  if (!state || state.command !== "discuss" || state.status !== "awaiting_human") {
    throw new ApprovalError(
      "not_awaiting_approval",
      `Run is not awaiting discussion approval: ${runId}`,
      "meguribi approve <runId>",
    );
  }
}

async function withDiscussionDecisionLock<T>(
  runId: string,
  deps: Pick<DiscussionDependencies, "runStore">,
  operation: (state: IssueRunState) => Promise<T>,
): Promise<T> {
  const initial = await deps.runStore.load(runId);
  assertAwaitingApproval(initial, runId);
  await deps.runStore.acquireLock({
    repository: initial.repository,
    issueNumber: initial.issueNumber,
    runId,
  });
  try {
    const reloaded = await deps.runStore.load(runId);
    assertAwaitingApproval(reloaded, runId);
    return await operation(reloaded);
  } finally {
    await deps.runStore
      .releaseLock({
        repository: initial.repository,
        issueNumber: initial.issueNumber,
      })
      .catch(() => undefined);
  }
}

async function readConclusionOrThrow(
  store: DiscussionStorePort,
): Promise<DiscussionConclusion> {
  const conclusion = await store.readConclusion();
  if (!conclusion) {
    throw new ApprovalError(
      "conclusion_missing",
      "Discussion conclusion is missing",
      "meguribi discuss で議論をやり直してください",
    );
  }
  return conclusion;
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<ApprovalRecord>;
  return (
    (record.decision === "approved" || record.decision === "rejected") &&
    typeof record.approver === "string" &&
    typeof record.at === "string" &&
    typeof record.conclusionHash === "string" &&
    (record.comment === undefined || typeof record.comment === "string") &&
    (record.redo === undefined || typeof record.redo === "boolean")
  );
}

async function readApprovalHistory(
  runStore: RunStore,
  runId: string,
): Promise<ApprovalRecord[]> {
  const value = await runStore.readArtifact<unknown>(runId, "approval-history.json");
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((record) => !isApprovalRecord(record))) {
    throw new Error("Invalid approval-history.json artifact");
  }
  return value.map((record) => ({ ...record }));
}

async function appendApprovalHistory(
  runStore: RunStore,
  runId: string,
  history: readonly ApprovalRecord[],
  approval: ApprovalRecord,
): Promise<void> {
  await runStore.saveArtifact(runId, "approval-history.json", [...history, approval]);
}

function requireNonEmpty(value: string, message: string): void {
  if (value.trim().length === 0) {
    throw new Error(message);
  }
}

export async function approveDiscussion(
  input: { runId: string; approver: string; comment?: string },
  deps: Pick<DiscussionDependencies, "runStore" | "createStore" | "hashConclusion" | "now">,
): Promise<DiscussionWorkflowResult> {
  requireNonEmpty(input.approver, "approve requires a non-empty approver");
  return withDiscussionDecisionLock(input.runId, deps, async () => {
    const store = deps.createStore(input.runId);
    const conclusion = await readConclusionOrThrow(store);
    const approval: ApprovalRecord = {
      decision: "approved",
      approver: input.approver,
      at: nowIso(deps),
      conclusionHash: deps.hashConclusion(conclusion),
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    };
    const history = await readApprovalHistory(deps.runStore, input.runId);
    await deps.runStore.saveArtifact(input.runId, "approval.json", approval);
    await appendApprovalHistory(deps.runStore, input.runId, history, approval);
    const updated = await deps.runStore.update(input.runId, {
      status: "completed",
      updatedAt: nowIso(deps),
    });
    return {
      runId: input.runId,
      status: updated.status,
      conclusion,
      reasons: [],
    };
  });
}

async function requireRedoInput(
  input: RejectDiscussionInput,
  state: IssueRunState,
  runStore: RunStore,
): Promise<RunDiscussionWorkflowInput> {
  const persisted = await readDiscussionInputArtifact(runStore, state.runId);
  const repositoryPath = input.repositoryPath ?? persisted?.repositoryPath;
  const repositoryRules = input.repositoryRules ?? persisted?.repositoryRules;
  const limits = input.limits ?? persisted?.limits;
  const artifactRoot = input.artifactRoot ?? persisted?.artifactRoot;
  const missing = [
    repositoryPath === undefined ? "repositoryPath" : undefined,
    repositoryRules === undefined ? "repositoryRules" : undefined,
    limits === undefined ? "limits" : undefined,
    artifactRoot === undefined ? "artifactRoot" : undefined,
  ].filter((key): key is string => key !== undefined);
  if (missing.length > 0) {
    throw new Error(`redo requires missing input: ${missing.join(", ")}`);
  }
  const userRequest = input.userRequest ?? persisted?.userRequest;
  return {
    repository: state.repository,
    issueNumber: state.issueNumber,
    repositoryPath: repositoryPath!,
    worktreePath: input.worktreePath ?? persisted?.worktreePath ?? state.worktreePath,
    branch: input.branch ?? persisted?.branch ?? state.branch,
    baseRef: input.baseRef ?? persisted?.baseRef ?? state.baseRef,
    requiredLabels: input.requiredLabels ?? persisted?.requiredLabels ?? [],
    repositoryRules: repositoryRules!,
    ...(userRequest === undefined ? {} : { userRequest }),
    limits: limits!,
    nonInteractive: input.nonInteractive ?? persisted?.nonInteractive ?? false,
    artifactRoot: artifactRoot!,
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
  };
}

function rejectedNotes(history: readonly ApprovalRecord[]): string[] {
  return history
    .filter((record) => record.decision === "rejected" && record.comment !== undefined)
    .map((record) => record.comment!);
}

export async function rejectDiscussion(
  input: RejectDiscussionInput,
  deps: DiscussionDependencies,
): Promise<DiscussionWorkflowResult> {
  requireNonEmpty(input.approver, "reject requires a non-empty approver");
  requireNonEmpty(input.reason, "reject requires a non-empty reason");
  return withDiscussionDecisionLock(input.runId, deps, async (state) => {
    const store = deps.createStore(input.runId);
    const conclusion = await readConclusionOrThrow(store);
    const previousHistory = await readApprovalHistory(deps.runStore, input.runId);
    const previousRejectedCount = previousHistory.filter(
      (record) => record.decision === "rejected",
    ).length;
    let redoInput: RunDiscussionWorkflowInput | undefined;
    if (input.redo) {
      if (previousRejectedCount >= 2) {
        throw new ApprovalError(
          "redo_limit_reached",
          "Discussion redo limit reached",
          "meguribi reject <runId> --reason <text> で却下を確定してください",
        );
      }
      redoInput = await requireRedoInput(input, state, deps.runStore);
    }

    const approval: ApprovalRecord = {
      decision: "rejected",
      approver: input.approver,
      at: nowIso(deps),
      conclusionHash: deps.hashConclusion(conclusion),
      comment: input.reason,
      redo: input.redo,
    };
    await deps.runStore.saveArtifact(input.runId, "approval.json", approval);
    await appendApprovalHistory(deps.runStore, input.runId, previousHistory, approval);

    if (!input.redo) {
      const updated = await deps.runStore.update(input.runId, {
        status: "completed",
        updatedAt: nowIso(deps),
      });
      return {
        runId: input.runId,
        status: updated.status,
        conclusion,
        reasons: [],
      };
    }

    const issue = await deps.github.getIssue(state.repository, state.issueNumber);
    const resetState = await deps.runStore.update(input.runId, {
      status: "created",
      currentStep: undefined,
      lastError: undefined,
      updatedAt: nowIso(deps),
    });
    const redoNotes = rejectedNotes([...previousHistory, approval]);
    const brief = createBrief(input.runId, redoInput!, issue, deps, redoNotes);
    const priorTurns = await store.readTurns();
    return await executeDiscussionWorkflowWithFailureResult(
      redoInput!,
      deps,
      requireIssueRunState(resetState),
      issue,
      store,
      brief,
      { startAt: "discuss", turnIdOffset: priorTurns.length },
    );
  });
}
