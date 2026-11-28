import type { DiscussionStorePort, SummarizeDiscussion } from "./ports.js";
import type { DiscussionBrief } from "./prompt.js";
import { runDiscussion, type EnvelopeParseResult } from "./room.js";
import type { DiscussionConclusion, DiscussionEndReason, DiscussionLimits, DiscussionTurn } from "./types.js";
import { agentDisplayName, type RoleAgent } from "../role-agent.js";
import type { RunState, RunStatus, RunStore } from "../delivery.js";
import type { WorkflowEvent } from "../workflow-engine/events.js";

export interface RunConsultationInput {
  runId: string;
  cwd: string;
  artifactRoot: string;
  topic: string;
  userRequest?: string;
  repositoryRules?: string;
  limits: DiscussionLimits;
  store?: Pick<DiscussionStorePort, "appendTurn" | "readHumanMessages" | "saveConclusion">;
  abortSignal?: AbortSignal;
  onEvent?: (event: WorkflowEvent) => void;
}

export interface ConsultationDependencies {
  discussants: readonly RoleAgent[];
  summarizer: RoleAgent;
  parseEnvelope(text: string): EnvelopeParseResult;
  summarize: SummarizeDiscussion;
  now?: () => Date;
}

export interface ConsultationResult {
  runId: string;
  turns: readonly DiscussionTurn[];
  endedBy: DiscussionEndReason;
  conclusion: DiscussionConclusion;
}

export interface RunPersistentConsultationInput {
  repository: string;
  repositoryPath: string;
  remoteIdentity: string;
  artifactRoot: string | ((runId: string) => string);
  topic: string;
  userRequest?: string;
  repositoryRules?: string;
  limits: DiscussionLimits;
  abortSignal?: AbortSignal;
  onEvent?: (event: WorkflowEvent) => void;
}

export type ConsultationDiscussionStore = Pick<
  DiscussionStorePort,
  "appendTurn" | "readHumanMessages" | "saveConclusion"
>;

export interface PersistentConsultationDependencies extends ConsultationDependencies {
  runStore: RunStore;
  createStore(runId: string): ConsultationDiscussionStore;
  onStateChange?: (state: Readonly<RunState>) => void | Promise<void>;
}

export interface PersistentConsultationResult {
  runId: string;
  status: RunStatus;
  turns: readonly DiscussionTurn[];
  endedBy?: DiscussionEndReason;
  conclusion?: DiscussionConclusion;
  reasons: string[];
}

export interface ConsultationInputArtifact {
  schemaVersion: 1;
  artifactType: "consultation-input";
  repository: string;
  repositoryPath: string;
  artifactRoot: string;
  topic: string;
  userRequest?: string;
  repositoryRules: string;
  limits: DiscussionLimits;
}

function nowIso(deps: Pick<ConsultationDependencies, "now">): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

async function notifyStateChange(
  deps: Pick<PersistentConsultationDependencies, "onStateChange">,
  state: RunState,
): Promise<void> {
  try {
    await deps.onStateChange?.(state);
  } catch {
    // State observers must not change the consultation result.
  }
}

async function updateConsultationRunState(
  deps: PersistentConsultationDependencies,
  runId: string,
  patch: Parameters<RunStore["update"]>[1],
): Promise<RunState> {
  const next = await deps.runStore.update(runId, {
    ...patch,
    updatedAt: nowIso(deps),
  });
  await notifyStateChange(deps, next);
  return next;
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

function consultationInputArtifact(input: RunPersistentConsultationInput, artifactRoot: string): ConsultationInputArtifact {
  return {
    schemaVersion: 1,
    artifactType: "consultation-input",
    repository: input.repository,
    repositoryPath: input.repositoryPath,
    artifactRoot,
    topic: input.topic,
    ...(input.userRequest !== undefined ? { userRequest: input.userRequest } : {}),
    repositoryRules: input.repositoryRules ?? "",
    limits: { ...input.limits },
  };
}

function resolveArtifactRoot(input: RunPersistentConsultationInput, runId: string): string {
  return typeof input.artifactRoot === "function" ? input.artifactRoot(runId) : input.artifactRoot;
}

function requireNonEmpty(value: string, message: string): void {
  if (value.trim().length === 0) {
    throw new Error(message);
  }
}

/**
 * Issue を持たない相談を永続 Run として実行する。
 * repository / remoteIdentity は呼び出し側が解決した実在値だけを受け付け、
 * Issue・branch・SHA・承認・delivery 継続設定は作らない。
 */
export async function runPersistentConsultation(
  input: RunPersistentConsultationInput,
  deps: PersistentConsultationDependencies,
): Promise<PersistentConsultationResult> {
  requireNonEmpty(input.topic, "consultation topic must not be empty");
  requireNonEmpty(input.repository, "consultation repository must not be empty");
  requireNonEmpty(input.repositoryPath, "consultation repositoryPath must not be empty");
  requireNonEmpty(input.remoteIdentity, "consultation remoteIdentity must not be empty");
  if (deps.discussants.length === 0) {
    throw new Error("consultation requires at least one discussant");
  }

  const state = await deps.runStore.create({
    repository: input.repository,
    command: "consult",
    consultation: {
      worktreePath: input.repositoryPath,
      remoteIdentity: input.remoteIdentity,
    },
    maxFixAttempts: 0,
  });
  await notifyStateChange(deps, state);

  const turns: DiscussionTurn[] = [];
  const artifactRoot = resolveArtifactRoot(input, state.runId);
  try {
    await deps.runStore.saveArtifact(state.runId, "consultation-input.json", consultationInputArtifact(input, artifactRoot));
    const store = deps.createStore(state.runId);
    const result = await runConsultation({
      runId: state.runId,
      cwd: input.repositoryPath,
      artifactRoot,
      topic: input.topic,
      ...(input.userRequest !== undefined ? { userRequest: input.userRequest } : {}),
      ...(input.repositoryRules !== undefined ? { repositoryRules: input.repositoryRules } : {}),
      limits: input.limits,
      store: {
        appendTurn: async (turn) => {
          await store.appendTurn(turn);
          turns.push(turn);
        },
        readHumanMessages: () => store.readHumanMessages(),
        saveConclusion: (value) => store.saveConclusion(value),
      },
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      ...(input.onEvent !== undefined ? { onEvent: input.onEvent } : {}),
    }, deps);
    await updateConsultationRunState(deps, state.runId, { status: "completed" });
    return {
      runId: state.runId,
      status: "completed",
      turns: result.turns,
      endedBy: result.endedBy,
      conclusion: result.conclusion,
      reasons: [],
    };
  } catch (error) {
    const status = statusForError(error);
    const message = errorMessage(error);
    await updateConsultationRunState(deps, state.runId, {
      status,
      lastError: { code: errorCode(error), message },
    }).catch(() => undefined);
    return {
      runId: state.runId,
      status,
      turns: [...turns],
      reasons: [message],
    };
  }
}

/**
 * Issue を持たない read-only 相談を1 Run として実行する。
 * GitHub Issue、ラベル、承認記録、delivery 継続設定を作らず、結論だけを返す。
 */
export async function runConsultation(
  input: RunConsultationInput,
  deps: ConsultationDependencies,
): Promise<ConsultationResult> {
  if (input.topic.trim().length === 0) {
    throw new Error("consultation topic must not be empty");
  }
  if (deps.discussants.length === 0) {
    throw new Error("consultation requires at least one discussant");
  }

  const brief: DiscussionBrief = {
    runId: input.runId,
    topic: input.topic,
    issueBody: "",
    comments: [],
    ...(input.userRequest !== undefined ? { userRequest: input.userRequest } : {}),
    repositoryRules: input.repositoryRules ?? "",
    participants: deps.discussants.map((agent) => ({
      id: agent.profileId,
      label: agentDisplayName(agent.kind),
    })),
    redoNotes: [],
  };
  const discussion = await runDiscussion({
    runId: input.runId,
    cwd: input.cwd,
    artifactRoot: input.artifactRoot,
    participants: deps.discussants,
    brief,
    limits: input.limits,
    ports: {
      parseEnvelope: deps.parseEnvelope,
      appendTurn: async (turn) => {
        await input.store?.appendTurn(turn);
      },
      readHumanMessages: async () => input.store?.readHumanMessages() ?? [],
      ...(input.onEvent !== undefined ? { onEvent: input.onEvent } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  });
  const conclusion = await deps.summarize({
    summarizer: deps.summarizer,
    cwd: input.cwd,
    artifactRoot: `${input.artifactRoot}/${deps.summarizer.profileId}`,
    brief,
    turns: discussion.turns,
    endedBy: discussion.endedBy,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  });
  await input.store?.saveConclusion(conclusion);
  return {
    runId: input.runId,
    turns: discussion.turns,
    endedBy: discussion.endedBy,
    conclusion,
  };
}
