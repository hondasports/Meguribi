import type { AgentError } from "../agent-error.js";
import type { AgentEvent } from "../agent-event.js";
import { agentDisplayName, type AgentKind } from "../role-agent.js";
import type {
  DeliveryDependencies,
  DeliveryResult,
  DeliveryStep,
  ImplementationResult,
  IssueRecord,
  PublishDecision,
  ResumeDeliveryInput,
  RunDeliveryInput,
  RunState,
  VerificationResult,
  VerificationLogWriter,
} from "../delivery.js";
import type { ImplementationContext } from "../implementation-context.js";
import type { PlanArtifact, ReviewArtifact } from "../codex-artifact.js";
import { matchesProtectedPath } from "../path-match.js";
import type { StepKind } from "../workflow-engine/definition.js";
import type { StepHandler } from "../workflow-engine/engine.js";
import { buildFixInstruction } from "./fix-instruction.js";

export interface PublishGateInput {
  implementation: ImplementationResult;
  verification: VerificationResult;
  review: ReviewArtifact;
  protectedPaths?: readonly string[];
  cleanupFailed?: boolean;
}

export function evaluatePublishGate(input: PublishGateInput): PublishDecision {
  const reasons: string[] = [];
  if (input.implementation.status !== "completed") {
    reasons.push(`implementation status is ${input.implementation.status}`);
  }
  if (!input.implementation.publishable) {
    reasons.push("implementation is not publishable");
  }
  if (input.implementation.mcpPolicyResult?.outcome === "block") {
    reasons.push("MCP policy blocked the run");
  }
  if (input.implementation.error?.code === "permission_denied") {
    reasons.push("permission was denied during implementation");
  }
  if (input.implementation.error?.code === "cleanup_failed" || input.cleanupFailed) {
    reasons.push("cleanup failure left safety state unknown");
  }
  if (!input.verification.success) {
    reasons.push("verification failed");
  }
  if (input.review.status === "changes_required") {
    reasons.push("Codex review requires changes");
  }
  if (input.review.status === "blocked") {
    reasons.push("Codex review blocked publishing");
  }
  const protectedPaths = input.protectedPaths ?? [];
  if (protectedPaths.length > 0) {
    const hits = input.implementation.changedFiles.filter((file) =>
      matchesProtectedPath(file, protectedPaths),
    );
    if (hits.length > 0) {
      reasons.push(`protected path changed without approval: ${hits.join(", ")}`);
    }
  }
  return { allowed: reasons.length === 0, reasons };
}

export function createVerificationLogWriter(
  deps: DeliveryDependencies,
  runId: string,
  prefix: string,
): VerificationLogWriter {
  return {
    async write(input) {
      const safeName =
        input.commandName.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64) || "command";
      const fileName = `logs/${prefix}-${String(input.commandIndex + 1).padStart(2, "0")}-${safeName}.log`;
      const truncation = input.truncated ? "\n[meguribi: output truncated]\n" : "";
      const content = ["[stdout]", input.stdout, "", "[stderr]", input.stderr, truncation].join(
        "\n",
      );
      return deps.runStore.saveArtifact(runId, fileName, content);
    },
  };
}

function nowIso(deps: DeliveryDependencies): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

export function isCancelledError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "cancelled"
  );
}

export function appendStep(state: RunState, step: DeliveryStep): DeliveryStep[] {
  if (state.completedSteps.includes(step)) {
    return state.completedSteps;
  }
  return [...state.completedSteps, step];
}

export async function mark(
  deps: DeliveryDependencies,
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
    // Progress reporting must never change the delivery result.
  }
  return next;
}

export async function cancelledResult(
  deps: DeliveryDependencies,
  state: RunState,
  reason: string,
  extras?: Partial<DeliveryResult>,
): Promise<DeliveryResult> {
  const next = await mark(deps, state.runId, {
    status: "cancelled",
    currentStep: "cancelled",
    completedSteps: appendStep(state, "cancelled"),
    lastError: {
      code: "cancelled",
      message: reason,
    },
  });
  return {
    runId: next.runId,
    status: next.status,
    published: false,
    reasons: [reason],
    ...extras,
  };
}

type ImplementerStepId = "implement" | "fix";

function implementerProfileOf(deps: DeliveryDependencies): { id: string; kind: AgentKind } {
  return deps.implementerProfile ?? { id: "devin", kind: "devin" };
}

function emitImplementerStepStarted(deps: DeliveryDependencies, stepId: ImplementerStepId): void {
  if (!deps.onAgentEvent) {
    return;
  }
  const profile = implementerProfileOf(deps);
  try {
    deps.onAgentEvent({
      type: "step.started",
      stepId,
      label: stepId,
      role: "implementer",
      profileId: profile.id,
      agentLabel: agentDisplayName(profile.kind),
    });
  } catch {
    // Live-log reporting must never change the delivery result.
  }
}

function forwardImplementerEvents(
  deps: DeliveryDependencies,
  stepId: ImplementerStepId,
): ((event: AgentEvent) => void) | undefined {
  if (!deps.onAgentEvent) {
    return undefined;
  }
  const profile = implementerProfileOf(deps);
  const agentLabel = agentDisplayName(profile.kind);
  const onAgentEvent = deps.onAgentEvent;
  return (event) => {
    try {
      onAgentEvent({
        type: "agent.event",
        stepId,
        profileId: profile.id,
        agentLabel,
        role: "implementer",
        event,
      });
    } catch {
      // Live-log reporting must never change the delivery result.
    }
  };
}

function buildImplementationContext(input: {
  issueBody: string;
  comments: readonly { body: string; id: number }[];
  plan: PlanArtifact;
  worktreePath: string;
  protectedPaths: readonly string[];
  verifyCommands: readonly { name: string; run: string }[];
  completionCriteria: readonly string[];
  repositoryRules: string;
  fixInstruction?: { source: string; content: string };
  previousAttempt?: { source: string; content: string };
}): ImplementationContext {
  const context: ImplementationContext = {
    issue: { source: "github-issue", content: input.issueBody },
    comments: input.comments.map((comment) => ({
      source: `comment:${comment.id}`,
      content: comment.body,
    })),
    acceptanceCriteria: [...input.completionCriteria],
    plan: {
      summary: input.plan.summary,
      steps: input.plan.steps,
    },
    repositoryRules: [input.repositoryRules, "Do not commit, push, or create PRs."]
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n"),
    primarySkill: "delivery-workflow",
    verificationCommands: input.verifyCommands.map((command) => command.run),
    protectedPaths: [...input.protectedPaths],
    worktreePath: input.worktreePath,
    allowedPaths: ["."],
    limits: {
      maxPromptChars: 48_000,
      maxChangedFiles: 50,
      maxDiffLines: 2_000,
    },
    expectedResult: ["implementation completed inside the worktree"],
  };
  if (input.fixInstruction) {
    context.fixInstruction = input.fixInstruction;
    context.fixContext = {
      ...(input.previousAttempt ? { previousAttempt: input.previousAttempt } : {}),
      fixInstruction: input.fixInstruction,
    };
  }
  return context;
}

export interface DeliveryRunContext {
  deps: DeliveryDependencies;
  delivery: RunDeliveryInput | ResumeDeliveryInput;
  state: RunState;
  issue: IssueRecord;
  plan?: PlanArtifact;
  implementation?: ImplementationResult;
  verification?: VerificationResult;
  review?: ReviewArtifact;
  /** resume 用: true のとき verify は既存の verification.json を再利用する */
  reuseVerification: boolean;
}

function requireRunDeliveryInput(
  delivery: RunDeliveryInput | ResumeDeliveryInput,
): RunDeliveryInput {
  if (!("completionCriteria" in delivery)) {
    throw new Error("run delivery input is required for plan and implementation steps");
  }
  return delivery;
}

function requirePlan(context: DeliveryRunContext): PlanArtifact {
  if (!context.plan) {
    throw new Error("plan artifact is required");
  }
  return context.plan;
}

function requireImplementation(context: DeliveryRunContext): ImplementationResult {
  if (!context.implementation) {
    throw new Error("implementation artifact is required");
  }
  return context.implementation;
}

function requireVerification(context: DeliveryRunContext): VerificationResult {
  if (!context.verification) {
    throw new Error("verification artifact is required before review");
  }
  return context.verification;
}

async function loadVerificationAndReview(
  context: DeliveryRunContext,
  releaseLock?: () => Promise<void>,
): Promise<void> {
  const verificationRead = context.deps.runStore.readArtifact<VerificationResult>(
    context.state.runId,
    "verification.json",
  );
  await releaseLock?.();
  context.verification = (await verificationRead) ?? undefined;
  context.review =
    (await context.deps.runStore.readArtifact<ReviewArtifact>(
      context.state.runId,
      "review.json",
    )) ?? undefined;
}

async function runReview(context: DeliveryRunContext): Promise<void> {
  const { deps, delivery, issue } = context;
  const plan = requirePlan(context);
  const implementation = requireImplementation(context);
  const verification = requireVerification(context);

  context.state = await mark(deps, context.state.runId, {
    status: "reviewing",
    currentStep: "reviewing",
  });
  const diff = await deps.git.getDiff(context.state.worktreePath);
  const review = await deps.codex.review({
    repositoryPath: context.state.worktreePath,
    issue,
    plan: {
      summary: plan.summary,
      requirements: plan.requirements,
      acceptanceCriteria: plan.acceptanceCriteria,
      outOfScope: plan.outOfScope,
      proposedFiles: plan.proposedFiles,
      steps: plan.steps,
      risks: plan.risks,
      tests: plan.tests,
      humanDecisions: plan.humanDecisions,
      unresolvedItems: plan.unresolvedItems,
    },
    diff: diff.patch,
    changedFiles: [...implementation.changedFiles],
    verification,
    repositoryRules: delivery.repositoryRules,
  });
  context.review = review;
  await deps.runStore.saveArtifact(context.state.runId, "review.json", review);
  context.state = await mark(deps, context.state.runId, {
    completedSteps: appendStep(context.state, "reviewing"),
    agentSessions: {
      ...context.state.agentSessions,
      codexReview: review.metadata.producer.threadId,
    },
  });
}

export async function runDeliveryFixAttempt(context: DeliveryRunContext): Promise<void> {
  const { deps, delivery, issue } = context;
  const plan = requirePlan(context);
  const previousImplementation = requireImplementation(context);
  const inputVerification = requireVerification(context);
  const inputReview = context.review;

  if (context.state.fixAttempts >= context.state.maxFixAttempts) {
    return;
  }

  context.state = await mark(deps, context.state.runId, {
    status: "fixing",
    currentStep: "fixing",
    fixAttempts: context.state.fixAttempts + 1,
  });

  const preflight = deps.assertImplementerReady ?? deps.assertDevinReady;
  if (preflight) {
    await preflight();
  }

  const fixInstruction = buildFixInstruction({
    verification: inputVerification,
    review: inputReview,
    previousSummary: previousImplementation.stopReason,
  });
  const implementationContext = buildImplementationContext({
    issueBody: `${issue.title}\n\n${issue.body}`,
    comments: issue.comments,
    plan,
    worktreePath: context.state.worktreePath,
    protectedPaths: delivery.protectedPaths,
    verifyCommands: delivery.verifyCommands,
    completionCriteria: plan.acceptanceCriteria,
    repositoryRules: delivery.repositoryRules,
    fixInstruction,
    previousAttempt: {
      source: "previous-implementation",
      content: JSON.stringify({
        status: previousImplementation.status,
        changedFiles: previousImplementation.changedFiles,
      }),
    },
  });

  emitImplementerStepStarted(deps, "fix");
  const implementation = await deps.implementer.fix({
    context: implementationContext,
    artifactRoot: `${delivery.artifactRootForDevin}-fix-${context.state.fixAttempts}`,
    gitBoundary: {
      expectedRemoteIdentity: context.state.remoteIdentity,
      expectedBaseSha: context.state.baseSha,
      expectedBranch: context.state.branch,
      outsidePaths: [],
      protectedPaths: delivery.protectedPaths,
      maxChangedFiles: 50,
      maxDiffLines: 2_000,
    },
    previousSessionId: previousImplementation.sessionId,
    abortSignal: delivery.abortSignal,
    onEvent: forwardImplementerEvents(deps, "fix"),
  });
  context.implementation = implementation;
  await deps.runStore.saveArtifact(
    context.state.runId,
    "implementation-result.json",
    implementation,
  );
  context.state = await mark(deps, context.state.runId, {
    completedSteps: appendStep(context.state, "fixing"),
    agentSessions: {
      ...context.state.agentSessions,
      devinImplementation: implementation.sessionId,
    },
    headSha: (await deps.git.getIdentity(context.state.worktreePath)).headSha,
  });

  const verification = await (async () => {
    try {
      return await deps.verifier.verify({
        worktreePath: context.state.worktreePath,
        commands: delivery.verifyCommands,
        abortSignal: delivery.abortSignal,
        timeoutMs: delivery.verifyTimeoutMs,
        logWriter: createVerificationLogWriter(
          deps,
          context.state.runId,
          `verify-fix-${String(context.state.fixAttempts)}`,
        ),
      });
    } catch (error) {
      if (isCancelledError(error) || delivery.abortSignal?.aborted) {
        throw Object.assign(new Error("cancelled during fix verification"), {
          code: "cancelled",
          message: "cancelled during fix verification",
          isRetryable: false,
        } satisfies AgentError);
      }
      throw error;
    }
  })();
  context.verification = verification;
  await deps.runStore.saveArtifact(context.state.runId, "verification.json", verification);

  if (verification.success) {
    const diff = await deps.git.getDiff(context.state.worktreePath);
    const review = await deps.codex.review({
      repositoryPath: context.state.worktreePath,
      issue,
      plan: {
        summary: plan.summary,
        requirements: plan.requirements,
        acceptanceCriteria: plan.acceptanceCriteria,
        outOfScope: plan.outOfScope,
        proposedFiles: plan.proposedFiles,
        steps: plan.steps,
        risks: plan.risks,
        tests: plan.tests,
        humanDecisions: plan.humanDecisions,
        unresolvedItems: plan.unresolvedItems,
      },
      diff: diff.patch,
      changedFiles: [...implementation.changedFiles],
      verification,
      repositoryRules: delivery.repositoryRules,
    });
    context.review = review;
    await deps.runStore.saveArtifact(context.state.runId, "review.json", review);
  }
}

function stopWith(result: DeliveryResult): { type: "stop"; result: DeliveryResult } {
  return { type: "stop", result };
}

async function planStep(context: DeliveryRunContext) {
  const { deps, issue } = context;
  const input = requireRunDeliveryInput(context.delivery);
  const plan = await deps.codex.createPlan({
    repositoryPath: input.repositoryPath,
    issue,
    repositoryRules: input.repositoryRules,
    completionCriteria: input.completionCriteria,
    outOfScope: input.outOfScope,
  });
  context.plan = plan;
  await deps.runStore.saveArtifact(context.state.runId, "plan.json", plan);
  context.state = await mark(deps, context.state.runId, {
    status: "planned",
    completedSteps: appendStep(context.state, "planning"),
    agentSessions: {
      ...context.state.agentSessions,
      codexPlan: plan.metadata.producer.threadId,
    },
    currentStep: "implementing",
  });

  if (input.abortSignal?.aborted) {
    context.state = await mark(deps, context.state.runId, {
      status: "cancelled",
      currentStep: "cancelled",
      completedSteps: appendStep(context.state, "cancelled"),
    });
    return stopWith({
      runId: context.state.runId,
      status: context.state.status,
      published: false,
      reasons: ["cancelled before implementation"],
    });
  }
  return { type: "continue" } as const;
}

async function implementStep(context: DeliveryRunContext) {
  const { deps, issue } = context;
  const input = requireRunDeliveryInput(context.delivery);
  const plan = requirePlan(context);
  context.state = await mark(deps, context.state.runId, { status: "implementing" });
  const implementationContext = buildImplementationContext({
    issueBody: `${issue.title}\n\n${issue.body}`,
    comments: issue.comments,
    plan,
    worktreePath: input.worktreePath,
    protectedPaths: input.protectedPaths,
    verifyCommands: input.verifyCommands,
    completionCriteria: input.completionCriteria,
    repositoryRules: input.repositoryRules,
  });
  emitImplementerStepStarted(deps, "implement");
  const implementation = await deps.implementer.implement({
    context: implementationContext,
    artifactRoot: input.artifactRootForDevin,
    gitBoundary: {
      expectedRemoteIdentity: context.state.remoteIdentity,
      expectedBaseSha: context.state.baseSha,
      expectedBranch: context.state.branch,
      outsidePaths: [],
      protectedPaths: input.protectedPaths,
      maxChangedFiles: 50,
      maxDiffLines: 2_000,
    },
    abortSignal: input.abortSignal,
    onEvent: forwardImplementerEvents(deps, "implement"),
  });
  context.implementation = implementation;
  await deps.runStore.saveArtifact(
    context.state.runId,
    "implementation-result.json",
    implementation,
  );

  if (implementation.status === "cancelled") {
    context.state = await mark(deps, context.state.runId, {
      status: "cancelled",
      currentStep: "cancelled",
      completedSteps: appendStep(context.state, "cancelled"),
      agentSessions: {
        ...context.state.agentSessions,
        devinImplementation: implementation.sessionId,
      },
    });
    return stopWith({
      runId: context.state.runId,
      status: context.state.status,
      implementation,
      published: false,
      reasons: ["implementation cancelled"],
    });
  }
  if (implementation.status === "timed_out") {
    context.state = await mark(deps, context.state.runId, {
      status: "timed_out",
      currentStep: "timed_out",
      completedSteps: appendStep(context.state, "timed_out"),
      agentSessions: {
        ...context.state.agentSessions,
        devinImplementation: implementation.sessionId,
      },
    });
    return stopWith({
      runId: context.state.runId,
      status: context.state.status,
      implementation,
      published: false,
      reasons: ["implementation timed out"],
    });
  }
  if (implementation.status !== "completed" || !implementation.publishable) {
    context.state = await mark(deps, context.state.runId, {
      status: "blocked",
      currentStep: "implementation_blocked",
      completedSteps: appendStep(context.state, "implementation_blocked"),
      agentSessions: {
        ...context.state.agentSessions,
        devinImplementation: implementation.sessionId,
      },
      lastError: implementation.error
        ? { code: implementation.error.code, message: implementation.error.message }
        : { code: "policy_blocked", message: "implementation was not publishable" },
    });
    return stopWith({
      runId: context.state.runId,
      status: context.state.status,
      implementation,
      published: false,
      reasons: [implementation.error?.message ?? "implementation was not publishable"],
    });
  }

  const identity = await deps.git.getIdentity(input.worktreePath);
  context.state = await mark(deps, context.state.runId, {
    status: "verifying",
    currentStep: "implementation_completed",
    completedSteps: appendStep(context.state, "implementation_completed"),
    headSha: identity.headSha,
    agentSessions: {
      ...context.state.agentSessions,
      devinImplementation: implementation.sessionId,
    },
  });
  return { type: "continue" } as const;
}

async function verifyStep(context: DeliveryRunContext, releaseLock?: () => Promise<void>) {
  const { deps, delivery } = context;
  await loadVerificationAndReview(context, releaseLock);

  if (!context.reuseVerification || !context.verification) {
    if (delivery.abortSignal?.aborted) {
      return stopWith(
        await cancelledResult(deps, context.state, "cancelled during verification", {
          implementation: context.implementation,
        }),
      );
    }
    context.state = await mark(deps, context.state.runId, {
      status: "verifying",
      currentStep: "verifying",
    });
    try {
      context.verification = await deps.verifier.verify({
        worktreePath: context.state.worktreePath,
        commands: delivery.verifyCommands,
        abortSignal: delivery.abortSignal,
        timeoutMs: delivery.verifyTimeoutMs,
        logWriter: createVerificationLogWriter(deps, context.state.runId, "verify"),
      });
    } catch (error) {
      if (isCancelledError(error) || delivery.abortSignal?.aborted) {
        return stopWith(
          await cancelledResult(deps, context.state, "cancelled during verification", {
            implementation: context.implementation,
          }),
        );
      }
      throw error;
    }
    await deps.runStore.saveArtifact(
      context.state.runId,
      "verification.json",
      context.verification,
    );
    context.state = await mark(deps, context.state.runId, {
      completedSteps: appendStep(context.state, "verifying"),
    });
  }

  if (delivery.abortSignal?.aborted) {
    return stopWith(
      await cancelledResult(deps, context.state, "cancelled before review", {
        implementation: context.implementation,
        verification: context.verification,
      }),
    );
  }

  const verification = requireVerification(context);
  return verification.success ? ({ type: "continue" } as const) : ({ type: "failure" } as const);
}

async function fixStep(context: DeliveryRunContext, of: string | undefined) {
  const { deps, delivery } = context;
  const implementationBeforeFix = context.implementation;
  const verificationBeforeFix = context.verification;
  const reviewBeforeFix = context.review;

  try {
    await runDeliveryFixAttempt(context);
  } catch (error) {
    if (isCancelledError(error) || delivery.abortSignal?.aborted) {
      return stopWith(
        await cancelledResult(deps, context.state, "cancelled during fix", {
          implementation: implementationBeforeFix,
          verification: verificationBeforeFix,
          ...(of === "review" ? { review: reviewBeforeFix } : {}),
        }),
      );
    }
    throw error;
  }

  const implementation = requireImplementation(context);
  const verification = requireVerification(context);
  if (of === "verify") {
    if (!verification.success) {
      context.state = await mark(deps, context.state.runId, {
        status: "blocked",
        currentStep: "implementation_blocked",
        completedSteps: appendStep(context.state, "implementation_blocked"),
        lastError: {
          code: "policy_blocked",
          message: "verification failed after fix attempts",
        },
      });
      return stopWith({
        runId: context.state.runId,
        status: context.state.status,
        implementation,
        verification,
        published: false,
        reasons: ["verification failed after fix attempts"],
      });
    }
    return { type: "continue" } as const;
  }

  const review = context.review;
  if (!review) {
    throw new Error("review artifact is required before review fix");
  }
  if (
    review.status === "changes_required" &&
    context.state.fixAttempts < context.state.maxFixAttempts
  ) {
    return { type: "changes_required" } as const;
  }
  if (review.status === "changes_required" || !verification.success) {
    context.state = await mark(deps, context.state.runId, {
      status: "blocked",
      currentStep: "implementation_blocked",
      lastError: {
        code: "policy_blocked",
        message: "review still requires changes after fix attempts",
      },
    });
    return stopWith({
      runId: context.state.runId,
      status: context.state.status,
      implementation,
      verification,
      review,
      published: false,
      reasons: ["review still requires changes after fix attempts"],
    });
  }
  return { type: "continue" } as const;
}

async function publishStep(context: DeliveryRunContext, releaseLock?: () => Promise<void>) {
  const { deps, delivery, issue } = context;
  if (!context.verification || !context.review) {
    await loadVerificationAndReview(context, releaseLock);
  }
  if (!context.verification || !context.review) {
    throw new Error("verification and review artifacts are required before publish");
  }
  const implementation = requireImplementation(context);
  const verification = context.verification;
  const review = context.review;

  if (delivery.abortSignal?.aborted) {
    return stopWith(
      await cancelledResult(deps, context.state, "cancelled before publish", {
        implementation,
        verification,
        review,
      }),
    );
  }

  const gate = evaluatePublishGate({
    implementation,
    verification,
    review,
    protectedPaths: delivery.protectedPaths,
    cleanupFailed: implementation.error?.code === "cleanup_failed",
  });
  const policyGate = await deps.policy.evaluatePublish({
    implementation,
    verification,
    reviewStatus: review.status,
    protectedPaths: delivery.protectedPaths,
  });
  const reasons = [...gate.reasons, ...policyGate.reasons];
  if (!gate.allowed || !policyGate.allowed) {
    context.state = await mark(deps, context.state.runId, {
      status: "blocked",
      currentStep: "implementation_blocked",
      lastError: {
        code: "policy_blocked",
        message: reasons.join("; ") || "publish gate blocked",
      },
    });
    return stopWith({
      runId: context.state.runId,
      status: context.state.status,
      implementation,
      verification,
      review,
      published: false,
      reasons,
    });
  }

  context.state = await mark(deps, context.state.runId, {
    status: "publishing",
    currentStep: "publishing",
  });

  if (!delivery.noCommit) {
    const committed = await deps.git.commit({
      worktreePath: context.state.worktreePath,
      paths: implementation.changedFiles,
      message: `feat: implement issue #${context.state.issueNumber}`,
    });
    context.state = await mark(deps, context.state.runId, { headSha: committed.headSha });
  }
  if (!delivery.noPush) {
    await deps.git.push({
      worktreePath: context.state.worktreePath,
      branch: context.state.branch,
    });
  }

  let pullRequestNumber = context.state.pullRequestNumber;
  if (!delivery.noPr) {
    const existing = await deps.github.findDraftPullRequest({
      repository: context.state.repository,
      head: context.state.branch,
    });
    if (existing) {
      pullRequestNumber = existing.number;
    } else {
      const created = await deps.github.createDraftPullRequest({
        repository: context.state.repository,
        title: issue.title,
        body: `Closes #${context.state.issueNumber}\n\nImplemented by Meguribi delivery workflow.`,
        head: context.state.branch,
        base: context.state.baseRef.replace(/^origin\//, ""),
      });
      pullRequestNumber = created.number;
    }
  }

  context.state = await mark(deps, context.state.runId, {
    status: "awaiting_human",
    currentStep: "awaiting_human",
    completedSteps: appendStep(context.state, "publishing"),
    pullRequestNumber,
  });

  await deps.github.upsertMarkerComment({
    repository: context.state.repository,
    issueNumber: context.state.issueNumber,
    marker: "<!-- meguribi:delivery-summary -->",
    body: [
      "<!-- meguribi:delivery-summary -->",
      `Run \`${context.state.runId}\` finished.`,
      pullRequestNumber ? `Draft PR: #${pullRequestNumber}` : "Draft PR skipped.",
    ].join("\n"),
  });

  return stopWith({
    runId: context.state.runId,
    status: context.state.status,
    implementation,
    verification,
    review,
    pullRequestNumber,
    published: true,
    reasons: [],
  });
}

export function createDeliveryStepHandlers(
  options: {
    releaseLock?: () => Promise<void>;
  } = {},
): Partial<Record<StepKind, StepHandler<DeliveryRunContext, DeliveryResult>>> {
  return {
    plan: async ({ context }) => planStep(context),
    implement: async ({ context }) => implementStep(context),
    verify: async ({ context }) => verifyStep(context, options.releaseLock),
    fix: async ({ context, step }) => fixStep(context, step.of),
    review: async ({ context }) => {
      await runReview(context);
      return context.review?.status === "changes_required"
        ? ({ type: "changes_required" } as const)
        : ({ type: "continue" } as const);
    },
    publish: async ({ context }) => publishStep(context, options.releaseLock),
  };
}
