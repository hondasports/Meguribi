import type {
  GitAdapter,
  GitHubAdapter,
  IssueRecord,
  PolicyEngine,
  RunState,
  RunStatus,
  RunStore,
} from "../delivery.js";
import type { DiscussionBrief } from "../discussion/prompt.js";
import type {
  DiscussionStoreFactory,
  DiscussionStorePort,
  SummarizeDiscussion,
} from "../discussion/ports.js";
import { runDiscussion, type EnvelopeParseResult } from "../discussion/room.js";
import type {
  DiscussionConclusion,
  DiscussionLimits,
  DiscussionTurn,
} from "../discussion/types.js";
import type { LiveLogEvent } from "../live-log.js";
import type { RoleAgent } from "../role-agent.js";
import type { StepKind } from "../workflow-engine/definition.js";
import type { StepHandler } from "../workflow-engine/engine.js";
import type { WorkflowEvent } from "../workflow-engine/events.js";

export interface DiscussionDependencies {
  github: GitHubAdapter;
  git: GitAdapter;
  policy: PolicyEngine;
  runStore: RunStore;
  discussants: readonly RoleAgent[];
  summarizer: RoleAgent;
  createStore: DiscussionStoreFactory;
  parseEnvelope(text: string): EnvelopeParseResult;
  summarize: SummarizeDiscussion;
  hashConclusion(conclusion: DiscussionConclusion): string;
  onWorkflowEvent?: (event: WorkflowEvent) => void;
  onStateChange?: (state: Readonly<RunState>) => void | Promise<void>;
  now?: () => Date;
}

export interface RunDiscussionWorkflowInput {
  repository: string;
  issueNumber: number;
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
  abortSignal?: AbortSignal;
}

export interface DiscussionWorkflowResult {
  runId: string;
  status: RunStatus;
  conclusion?: DiscussionConclusion;
  reasons: string[];
}

export interface DiscussionWorkflowContext {
  deps: DiscussionDependencies;
  input: RunDiscussionWorkflowInput;
  state: RunState;
  issue: IssueRecord;
  brief: DiscussionBrief;
  store: DiscussionStorePort;
  turns: readonly DiscussionTurn[];
  turnIdOffset: number;
  conclusion?: DiscussionConclusion;
}

function nowIso(deps: Pick<DiscussionDependencies, "now">): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

export async function updateDiscussionRunState(
  deps: Pick<DiscussionDependencies, "runStore" | "onStateChange" | "now">,
  runId: string,
  patch: Partial<RunState>,
): Promise<RunState> {
  const next = await deps.runStore.update(runId, {
    ...patch,
    updatedAt: nowIso(deps),
  });
  try {
    await deps.onStateChange?.(next);
  } catch {
    // State observers must not change the workflow result.
  }
  return next;
}

function forwardLiveLogEvent(
  deps: DiscussionDependencies,
): ((event: LiveLogEvent) => void) | undefined {
  if (!deps.onWorkflowEvent) {
    return undefined;
  }
  return (event) => {
    deps.onWorkflowEvent?.(event);
  };
}

function shiftTurnId(turnId: string, offset: number): string {
  const match = /^t-(\d+)$/.exec(turnId);
  if (!match) {
    return turnId;
  }
  return `t-${String(Number(match[1]) + offset)}`;
}

function adjustTurnForOffset(turn: DiscussionTurn, offset: number): DiscussionTurn {
  if (offset === 0) {
    return turn;
  }
  return {
    ...turn,
    turnId: shiftTurnId(turn.turnId, offset),
    envelope: {
      ...turn.envelope,
      replyTo: turn.envelope.replyTo.map((turnId) => shiftTurnId(turnId, offset)),
    },
  };
}

function forwardWorkflowEvent(
  deps: DiscussionDependencies,
  turnIdOffset: number,
): ((event: WorkflowEvent) => void) | undefined {
  if (!deps.onWorkflowEvent) {
    return undefined;
  }
  return (event) => {
    if (event.type === "discussion.turn") {
      deps.onWorkflowEvent?.({
        ...event,
        turn: adjustTurnForOffset(event.turn, turnIdOffset),
      });
      return;
    }
    deps.onWorkflowEvent?.(event);
  };
}

async function discussStep(context: DiscussionWorkflowContext) {
  const { deps, input } = context;
  const adjustedTurns: DiscussionTurn[] = [];
  const discussion = await runDiscussion({
    runId: context.state.runId,
    cwd: input.worktreePath,
    artifactRoot: input.artifactRoot,
    participants: deps.discussants,
    brief: context.brief,
    limits: input.limits,
    ports: {
      parseEnvelope: deps.parseEnvelope,
      appendTurn: async (turn) => {
        const adjusted = adjustTurnForOffset(turn, context.turnIdOffset);
        await context.store.appendTurn(adjusted);
        adjustedTurns.push(adjusted);
      },
      readHumanMessages: () => context.store.readHumanMessages(),
      onEvent: forwardWorkflowEvent(deps, context.turnIdOffset),
      now: deps.now,
    },
    abortSignal: input.abortSignal,
  });
  const conclusion = await deps.summarize({
    summarizer: deps.summarizer,
    cwd: input.worktreePath,
    artifactRoot: `${input.artifactRoot}/${deps.summarizer.profileId}`,
    brief: context.brief,
    turns: adjustedTurns,
    endedBy: discussion.endedBy,
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    onEvent: forwardLiveLogEvent(deps),
  });
  await context.store.saveConclusion(conclusion);
  context.turns = adjustedTurns;
  context.conclusion = conclusion;
  return { type: "continue" } as const;
}

async function approveStep(context: DiscussionWorkflowContext) {
  if (!context.conclusion) {
    throw new Error("discussion conclusion is required before approve");
  }
  context.state = await updateDiscussionRunState(context.deps, context.state.runId, {
    status: "awaiting_human",
    currentStep: "awaiting_human",
  });
  const result: DiscussionWorkflowResult = {
    runId: context.state.runId,
    status: context.state.status,
    conclusion: context.conclusion,
    reasons: [],
  };
  return {
    type: "stop",
    result,
  } as const;
}

export function createDiscussionStepHandlers(): Partial<
  Record<StepKind, StepHandler<DiscussionWorkflowContext, DiscussionWorkflowResult>>
> {
  return {
    discuss: async ({ context }) => discussStep(context),
    approve: async ({ context }) => approveStep(context),
  };
}
