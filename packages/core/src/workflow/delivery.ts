import type { AgentError } from "../agent-error.js";
import type {
  DeliveryDependencies,
  DeliveryResult,
  DeliveryStep,
  ImplementationResult,
  PublishDecision,
  ResumeDeliveryInput,
  RunDeliveryInput,
  RunState,
  RunStatus,
  VerificationResult,
  VerificationLogWriter,
} from "../delivery.js";
import type { ImplementationContext } from "../implementation-context.js";
import type { PlanArtifact, ReviewArtifact } from "../codex-artifact.js";
import { decideInheritedMcpPolicy } from "../mcp-policy.js";
import { matchesProtectedPath } from "../path-match.js";
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

function createVerificationLogWriter(
  deps: DeliveryDependencies,
  runId: string,
  prefix: string,
): VerificationLogWriter {
  return {
    async write(input) {
      const safeName = input.commandName.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64) || "command";
      const fileName = `logs/${prefix}-${String(input.commandIndex + 1).padStart(2, "0")}-${safeName}.log`;
      const truncation = input.truncated ? "\n[meguribi: output truncated]\n" : "";
      const content = [
        "[stdout]",
        input.stdout,
        "",
        "[stderr]",
        input.stderr,
        truncation,
      ].join("\n");
      return deps.runStore.saveArtifact(runId, fileName, content);
    },
  };
}

function nowIso(deps: DeliveryDependencies): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function isCancelledError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "cancelled"
  );
}

async function cancelledResult(
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

function appendStep(state: RunState, step: DeliveryStep): DeliveryStep[] {
  if (state.completedSteps.includes(step)) {
    return state.completedSteps;
  }
  return [...state.completedSteps, step];
}

async function mark(
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

function toAgentError(error: unknown, fallbackCode: AgentError["code"]): AgentError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    typeof (error as AgentError).code === "string" &&
    typeof (error as AgentError).message === "string"
  ) {
    return error as AgentError;
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    isRetryable: false,
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
    repositoryRules: [
      input.repositoryRules,
      "Do not commit, push, or create PRs.",
    ]
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

async function assertIdentity(
  deps: DeliveryDependencies,
  state: RunState,
): Promise<void> {
  const identity = await deps.git.getIdentity(state.worktreePath);
  if (
    identity.branch !== state.branch ||
    identity.headSha !== state.headSha ||
    identity.remoteIdentity !== state.remoteIdentity
  ) {
    throw Object.assign(new Error("Run identity mismatch: worktree/branch/HEAD/remote do not match saved state"), {
      code: "policy_blocked",
      message: "Run identity mismatch: worktree/branch/HEAD/remote do not match saved state",
      isRetryable: false,
    } satisfies AgentError);
  }
}

async function runVerifyReviewPublish(input: {
  deps: DeliveryDependencies;
  state: RunState;
  delivery: RunDeliveryInput | ResumeDeliveryInput;
  implementation: ImplementationResult;
  plan: PlanArtifact;
  issue: Awaited<ReturnType<DeliveryDependencies["github"]["getIssue"]>>;
  startFrom: "verifying" | "reviewing" | "publishing";
}): Promise<DeliveryResult> {
  const { deps, delivery } = input;
  let state = input.state;
  let implementation = input.implementation;
  let verification: VerificationResult | undefined =
    (await deps.runStore.readArtifact<VerificationResult>(state.runId, "verification.json")) ?? undefined;
  let review: ReviewArtifact | undefined =
    (await deps.runStore.readArtifact<ReviewArtifact>(state.runId, "review.json")) ?? undefined;

  if (input.startFrom === "verifying" || !verification) {
    if (delivery.abortSignal?.aborted) {
      return cancelledResult(deps, state, "cancelled during verification", {
        implementation: input.implementation,
      });
    }
    state = await mark(deps, state.runId, {
      status: "verifying",
      currentStep: "verifying",
    });
    try {
      verification = await deps.verifier.verify({
        worktreePath: state.worktreePath,
        commands: delivery.verifyCommands,
        abortSignal: delivery.abortSignal,
        timeoutMs: delivery.verifyTimeoutMs,
        logWriter: createVerificationLogWriter(deps, state.runId, "verify"),
      });
    } catch (error) {
      if (isCancelledError(error) || delivery.abortSignal?.aborted) {
        return cancelledResult(deps, state, "cancelled during verification", {
          implementation: input.implementation,
        });
      }
      throw error;
    }
    await deps.runStore.saveArtifact(state.runId, "verification.json", verification);
    state = await mark(deps, state.runId, {
      completedSteps: appendStep(state, "verifying"),
    });
  }

  if (delivery.abortSignal?.aborted) {
    return cancelledResult(deps, state, "cancelled before review", {
      implementation,
      verification,
    });
  }

  if (input.startFrom !== "publishing") {
    if (!verification) {
      throw new Error("verification artifact is required before review");
    }
    const needsFixFromVerify = !verification.success;
    if (needsFixFromVerify) {
      try {
        const fixResult = await maybeFix({
          deps,
          state,
          delivery,
          plan: input.plan,
          issue: input.issue,
          verification,
          review: undefined,
          previousImplementation: implementation,
        });
        state = fixResult.state;
        implementation = fixResult.implementation;
        verification = fixResult.verification;
      } catch (error) {
        if (isCancelledError(error) || delivery.abortSignal?.aborted) {
          return cancelledResult(deps, state, "cancelled during fix", {
            implementation,
            verification,
          });
        }
        throw error;
      }
      if (!verification.success) {
        state = await mark(deps, state.runId, {
          status: "blocked",
          currentStep: "implementation_blocked",
          completedSteps: appendStep(state, "implementation_blocked"),
          lastError: {
            code: "policy_blocked",
            message: "verification failed after fix attempts",
          },
        });
        return {
          runId: state.runId,
          status: state.status,
          implementation,
          verification,
          published: false,
          reasons: ["verification failed after fix attempts"],
        };
      }
    }

    state = await mark(deps, state.runId, {
      status: "reviewing",
      currentStep: "reviewing",
    });
    const diff = await deps.git.getDiff(state.worktreePath);
    review = await deps.codex.review({
      repositoryPath: state.worktreePath,
      issue: input.issue,
      plan: {
        summary: input.plan.summary,
        requirements: input.plan.requirements,
        acceptanceCriteria: input.plan.acceptanceCriteria,
        outOfScope: input.plan.outOfScope,
        proposedFiles: input.plan.proposedFiles,
        steps: input.plan.steps,
        risks: input.plan.risks,
        tests: input.plan.tests,
        humanDecisions: input.plan.humanDecisions,
        unresolvedItems: input.plan.unresolvedItems,
      },
      diff: diff.patch,
      changedFiles: [...implementation.changedFiles],
      verification,
      repositoryRules: delivery.repositoryRules,
    });
    await deps.runStore.saveArtifact(state.runId, "review.json", review);
    state = await mark(deps, state.runId, {
      completedSteps: appendStep(state, "reviewing"),
      agentSessions: {
        ...state.agentSessions,
        codexReview: review.metadata.producer.threadId,
      },
    });

    while (review.status === "changes_required") {
      try {
        const fixResult = await maybeFix({
          deps,
          state,
          delivery,
          plan: input.plan,
          issue: input.issue,
          verification,
          review,
          previousImplementation: implementation,
        });
        state = fixResult.state;
        implementation = fixResult.implementation;
        verification = fixResult.verification;
        review = fixResult.review ?? review;
      } catch (error) {
        if (isCancelledError(error) || delivery.abortSignal?.aborted) {
          return cancelledResult(deps, state, "cancelled during fix", {
            implementation,
            verification,
            review,
          });
        }
        throw error;
      }
      if (review.status === "changes_required" && state.fixAttempts < state.maxFixAttempts) {
        continue;
      }
      if (review.status === "changes_required" || !verification.success) {
        state = await mark(deps, state.runId, {
          status: "blocked",
          currentStep: "implementation_blocked",
          lastError: {
            code: "policy_blocked",
            message: "review still requires changes after fix attempts",
          },
        });
        return {
          runId: state.runId,
          status: state.status,
          implementation,
          verification,
          review,
          published: false,
          reasons: ["review still requires changes after fix attempts"],
        };
      }
    }
  }

  if (!verification || !review) {
    throw new Error("verification and review artifacts are required before publish");
  }

  if (delivery.abortSignal?.aborted) {
    return cancelledResult(deps, state, "cancelled before publish", {
      implementation,
      verification,
      review,
    });
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
    state = await mark(deps, state.runId, {
      status: "blocked",
      currentStep: "implementation_blocked",
      lastError: {
        code: "policy_blocked",
        message: reasons.join("; ") || "publish gate blocked",
      },
    });
    return {
      runId: state.runId,
      status: state.status,
      implementation,
      verification,
      review,
      published: false,
      reasons,
    };
  }

  state = await mark(deps, state.runId, {
    status: "publishing",
    currentStep: "publishing",
  });

  if (!delivery.noCommit) {
    const committed = await deps.git.commit({
      worktreePath: state.worktreePath,
      paths: implementation.changedFiles,
      message: `feat: implement issue #${state.issueNumber}`,
    });
    state = await mark(deps, state.runId, { headSha: committed.headSha });
  }
  if (!delivery.noPush) {
    await deps.git.push({
      worktreePath: state.worktreePath,
      branch: state.branch,
    });
  }

  let pullRequestNumber = state.pullRequestNumber;
  if (!delivery.noPr) {
    const existing = await deps.github.findDraftPullRequest({
      repository: state.repository,
      head: state.branch,
    });
    if (existing) {
      pullRequestNumber = existing.number;
    } else {
      const created = await deps.github.createDraftPullRequest({
        repository: state.repository,
        title: input.issue.title,
        body: `Closes #${state.issueNumber}\n\nImplemented by Meguribi delivery workflow.`,
        head: state.branch,
        base: state.baseRef.replace(/^origin\//, ""),
      });
      pullRequestNumber = created.number;
    }
  }

  state = await mark(deps, state.runId, {
    status: "awaiting_human",
    currentStep: "awaiting_human",
    completedSteps: appendStep(state, "publishing"),
    pullRequestNumber,
  });

  await deps.github.upsertMarkerComment({
    repository: state.repository,
    issueNumber: state.issueNumber,
    marker: "<!-- meguribi:delivery-summary -->",
    body: [
      "<!-- meguribi:delivery-summary -->",
      `Run \`${state.runId}\` finished.`,
      pullRequestNumber ? `Draft PR: #${pullRequestNumber}` : "Draft PR skipped.",
    ].join("\n"),
  });

  return {
    runId: state.runId,
    status: state.status,
    implementation,
    verification,
    review,
    pullRequestNumber,
    published: true,
    reasons: [],
  };
}

async function maybeFix(input: {
  deps: DeliveryDependencies;
  state: RunState;
  delivery: RunDeliveryInput | ResumeDeliveryInput;
  plan: PlanArtifact;
  issue: Awaited<ReturnType<DeliveryDependencies["github"]["getIssue"]>>;
  verification: VerificationResult;
  review?: ReviewArtifact;
  previousImplementation: ImplementationResult;
}): Promise<{
  state: RunState;
  implementation: ImplementationResult;
  verification: VerificationResult;
  review?: ReviewArtifact;
}> {
  const { deps, delivery } = input;
  let state = input.state;
  if (state.fixAttempts >= state.maxFixAttempts) {
    return {
      state,
      implementation: input.previousImplementation,
      verification: input.verification,
      review: input.review,
    };
  }

  state = await mark(deps, state.runId, {
    status: "fixing",
    currentStep: "fixing",
    fixAttempts: state.fixAttempts + 1,
  });

  const preflight = deps.assertImplementerReady ?? deps.assertDevinReady;
  if (preflight) {
    await preflight();
  }

  const fixInstruction = buildFixInstruction({
    verification: input.verification,
    review: input.review,
    previousSummary: input.previousImplementation.stopReason,
  });
  const context = buildImplementationContext({
    issueBody: `${input.issue.title}\n\n${input.issue.body}`,
    comments: input.issue.comments,
    plan: input.plan,
    worktreePath: state.worktreePath,
    protectedPaths: delivery.protectedPaths,
    verifyCommands: delivery.verifyCommands,
    completionCriteria: input.plan.acceptanceCriteria,
    repositoryRules: delivery.repositoryRules,
    fixInstruction,
    previousAttempt: {
      source: "previous-implementation",
      content: JSON.stringify({
        status: input.previousImplementation.status,
        changedFiles: input.previousImplementation.changedFiles,
      }),
    },
  });

  const implementation = await deps.implementer.fix({
    context,
    artifactRoot: `${delivery.artifactRootForDevin}-fix-${state.fixAttempts}`,
    gitBoundary: {
      expectedRemoteIdentity: state.remoteIdentity,
      expectedBaseSha: state.baseSha,
      expectedBranch: state.branch,
      outsidePaths: [],
      protectedPaths: delivery.protectedPaths,
      maxChangedFiles: 50,
      maxDiffLines: 2_000,
    },
    previousSessionId: input.previousImplementation.sessionId,
    abortSignal: delivery.abortSignal,
  });
  await deps.runStore.saveArtifact(state.runId, "implementation-result.json", implementation);
  state = await mark(deps, state.runId, {
    completedSteps: appendStep(state, "fixing"),
    agentSessions: {
      ...state.agentSessions,
      devinImplementation: implementation.sessionId,
    },
    headSha: (await deps.git.getIdentity(state.worktreePath)).headSha,
  });

  const verification = await (async () => {
    try {
      return await deps.verifier.verify({
        worktreePath: state.worktreePath,
        commands: delivery.verifyCommands,
        abortSignal: delivery.abortSignal,
        timeoutMs: delivery.verifyTimeoutMs,
        logWriter: createVerificationLogWriter(
          deps,
          state.runId,
          `verify-fix-${String(state.fixAttempts)}`,
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
  await deps.runStore.saveArtifact(state.runId, "verification.json", verification);

  let review = input.review;
  if (verification.success) {
    const diff = await deps.git.getDiff(state.worktreePath);
    review = await deps.codex.review({
      repositoryPath: state.worktreePath,
      issue: input.issue,
      plan: {
        summary: input.plan.summary,
        requirements: input.plan.requirements,
        acceptanceCriteria: input.plan.acceptanceCriteria,
        outOfScope: input.plan.outOfScope,
        proposedFiles: input.plan.proposedFiles,
        steps: input.plan.steps,
        risks: input.plan.risks,
        tests: input.plan.tests,
        humanDecisions: input.plan.humanDecisions,
        unresolvedItems: input.plan.unresolvedItems,
      },
      diff: diff.patch,
      changedFiles: [...implementation.changedFiles],
      verification,
      repositoryRules: delivery.repositoryRules,
    });
    await deps.runStore.saveArtifact(state.runId, "review.json", review);
  }

  return { state, implementation, verification, review };
}

export async function runDelivery(
  input: RunDeliveryInput,
  deps: DeliveryDependencies,
): Promise<DeliveryResult> {
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

  const state = await deps.runStore.create({
    repository: input.repository,
    issueNumber: input.issueNumber,
    command: "run",
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
    maxFixAttempts: input.maxFixAttempts,
  });
  await deps.runStore.acquireLock({
    repository: input.repository,
    issueNumber: input.issueNumber,
    runId: state.runId,
  });

  try {
    let current = await mark(deps, state.runId, {
      status: "created",
      currentStep: "preflight",
      completedSteps: appendStep(state, "context"),
    });
    const preflight = deps.assertImplementerReady ?? deps.assertDevinReady;
    if (preflight) {
      await preflight();
    }
    current = await mark(deps, current.runId, {
      completedSteps: appendStep(current, "preflight"),
      currentStep: "awaiting_mcp_confirmation",
    });

    const mcpDecision = decideInheritedMcpPolicy({
      policy: input.inheritedMcpPolicy,
      mode: input.nonInteractive ? "non-interactive" : "interactive",
      explicitAllow: input.allowInheritedMcp,
      detection: { detected: false, transport: "unknown" },
    });
    if (mcpDecision.outcome === "confirm") {
      const confirmed = deps.mcpConfirmation
        ? await deps.mcpConfirmation.confirmInheritedMcp()
        : false;
      if (!confirmed) {
        current = await mark(deps, current.runId, {
          status: "blocked",
          currentStep: "awaiting_mcp_confirmation",
          lastError: {
            code: "policy_blocked",
            message: "inherited MCP confirmation was denied",
          },
        });
        return {
          runId: current.runId,
          status: current.status,
          published: false,
          reasons: ["inherited MCP confirmation was denied"],
        };
      }
    } else if (mcpDecision.outcome === "block") {
      current = await mark(deps, current.runId, {
        status: "blocked",
        currentStep: "awaiting_mcp_confirmation",
        lastError: {
          code: "policy_blocked",
          message: mcpDecision.reason,
        },
      });
      return {
        runId: current.runId,
        status: current.status,
        published: false,
        reasons: [mcpDecision.reason],
      };
    }
    current = await mark(deps, current.runId, {
      completedSteps: appendStep(current, "awaiting_mcp_confirmation"),
      currentStep: "worktree",
    });
    current = await mark(deps, current.runId, {
      completedSteps: appendStep(current, "worktree"),
      status: "planning",
      currentStep: "planning",
    });

    const plan = await deps.codex.createPlan({
      repositoryPath: input.repositoryPath,
      issue,
      repositoryRules: input.repositoryRules,
      completionCriteria: input.completionCriteria,
      outOfScope: input.outOfScope,
    });
    await deps.runStore.saveArtifact(current.runId, "plan.json", plan);
    current = await mark(deps, current.runId, {
      status: "planned",
      completedSteps: appendStep(current, "planning"),
      agentSessions: {
        ...current.agentSessions,
        codexPlan: plan.metadata.producer.threadId,
      },
      currentStep: "implementing",
    });

    if (input.abortSignal?.aborted) {
      current = await mark(deps, current.runId, {
        status: "cancelled",
        currentStep: "cancelled",
        completedSteps: appendStep(current, "cancelled"),
      });
      return {
        runId: current.runId,
        status: current.status,
        published: false,
        reasons: ["cancelled before implementation"],
      };
    }

    current = await mark(deps, current.runId, { status: "implementing" });
    const context = buildImplementationContext({
      issueBody: `${issue.title}\n\n${issue.body}`,
      comments: issue.comments,
      plan,
      worktreePath: input.worktreePath,
      protectedPaths: input.protectedPaths,
      verifyCommands: input.verifyCommands,
      completionCriteria: input.completionCriteria,
      repositoryRules: input.repositoryRules,
    });
    const implementation = await deps.implementer.implement({
      context,
      artifactRoot: input.artifactRootForDevin,
      gitBoundary: {
        expectedRemoteIdentity: current.remoteIdentity,
        expectedBaseSha: current.baseSha,
        expectedBranch: current.branch,
        outsidePaths: [],
        protectedPaths: input.protectedPaths,
        maxChangedFiles: 50,
        maxDiffLines: 2_000,
      },
      abortSignal: input.abortSignal,
    });
    await deps.runStore.saveArtifact(current.runId, "implementation-result.json", implementation);

    if (implementation.status === "cancelled") {
      current = await mark(deps, current.runId, {
        status: "cancelled",
        currentStep: "cancelled",
        completedSteps: appendStep(current, "cancelled"),
        agentSessions: {
          ...current.agentSessions,
          devinImplementation: implementation.sessionId,
        },
      });
      return {
        runId: current.runId,
        status: current.status,
        implementation,
        published: false,
        reasons: ["implementation cancelled"],
      };
    }
    if (implementation.status === "timed_out") {
      current = await mark(deps, current.runId, {
        status: "timed_out",
        currentStep: "timed_out",
        completedSteps: appendStep(current, "timed_out"),
        agentSessions: {
          ...current.agentSessions,
          devinImplementation: implementation.sessionId,
        },
      });
      return {
        runId: current.runId,
        status: current.status,
        implementation,
        published: false,
        reasons: ["implementation timed out"],
      };
    }
    if (implementation.status !== "completed" || !implementation.publishable) {
      current = await mark(deps, current.runId, {
        status: "blocked",
        currentStep: "implementation_blocked",
        completedSteps: appendStep(current, "implementation_blocked"),
        agentSessions: {
          ...current.agentSessions,
          devinImplementation: implementation.sessionId,
        },
        lastError: implementation.error
          ? { code: implementation.error.code, message: implementation.error.message }
          : { code: "policy_blocked", message: "implementation was not publishable" },
      });
      return {
        runId: current.runId,
        status: current.status,
        implementation,
        published: false,
        reasons: [implementation.error?.message ?? "implementation was not publishable"],
      };
    }

    const identity = await deps.git.getIdentity(input.worktreePath);
    current = await mark(deps, current.runId, {
      status: "verifying",
      currentStep: "implementation_completed",
      completedSteps: appendStep(current, "implementation_completed"),
      headSha: identity.headSha,
      agentSessions: {
        ...current.agentSessions,
        devinImplementation: implementation.sessionId,
      },
    });

    return runVerifyReviewPublish({
      deps,
      state: current,
      delivery: input,
      implementation,
      plan,
      issue,
      startFrom: "verifying",
    });
  } catch (error) {
    const agentError = toAgentError(error, "unknown");
    await mark(deps, state.runId, {
      status: mapErrorStatus(agentError),
      lastError: { code: agentError.code, message: agentError.message },
    }).catch(() => undefined);
    return {
      runId: state.runId,
      status: mapErrorStatus(agentError),
      published: false,
      reasons: [agentError.message],
    };
  } finally {
    await deps.runStore.releaseLock({
      repository: input.repository,
      issueNumber: input.issueNumber,
    }).catch(() => undefined);
  }
}

function mapErrorStatus(error: AgentError): RunStatus {
  if (error.code === "cancelled") return "cancelled";
  if (error.code === "timeout") return "timed_out";
  if (error.code === "policy_blocked" || error.code === "permission_denied") return "blocked";
  return "failed";
}

export async function resumeDelivery(
  input: ResumeDeliveryInput,
  deps: DeliveryDependencies,
): Promise<DeliveryResult> {
  const state =
    (input.runId
      ? await deps.runStore.load(input.runId)
      : await deps.runStore.loadLatest(input.repository, input.issueNumber));
  if (!state) {
    throw new Error("No run found to resume");
  }
  if (state.repository !== input.repository || state.issueNumber !== input.issueNumber) {
    throw Object.assign(
      new Error(
        `Run identity mismatch: requested ${input.repository}#${String(input.issueNumber)} but loaded ${state.repository}#${String(state.issueNumber)}`,
      ),
      {
        code: "policy_blocked",
        message: `Run identity mismatch: requested ${input.repository}#${String(input.issueNumber)} but loaded ${state.repository}#${String(state.issueNumber)}`,
        isRetryable: false,
      } satisfies AgentError,
    );
  }

  await deps.runStore.acquireLock({
    repository: state.repository,
    issueNumber: state.issueNumber,
    runId: state.runId,
  });

  try {
    await assertIdentity(deps, state);

    const unsafeResumeStatuses = new Set<RunStatus>([
      "implementing",
      "fixing",
      "planning",
      "created",
    ]);
    const unsafeResumeSteps = new Set<DeliveryStep>([
      "implementing",
      "fixing",
      "cancelling",
      "planning",
      "preflight",
      "awaiting_mcp_confirmation",
      "worktree",
    ]);
    if (
      unsafeResumeStatuses.has(state.status) ||
      (state.currentStep && unsafeResumeSteps.has(state.currentStep)) ||
      !state.completedSteps.includes("implementation_completed")
    ) {
      const updated = await mark(deps, state.runId, {
        status: "blocked",
        lastError: {
          code: "policy_blocked",
          message:
            "Mid-implementation or mid-fix resume is not supported; resume only after implementation_completed",
        },
      });
      return {
        runId: updated.runId,
        status: updated.status,
        published: false,
        reasons: [
          "Mid-implementation or mid-fix resume is not supported; resume only after implementation_completed",
        ],
      };
    }

    const issue = await deps.github.getIssue(state.repository, state.issueNumber);
    const rawPlan = await deps.runStore.readArtifact<unknown>(state.runId, "plan.json");
    const rawImplementation = await deps.runStore.readArtifact<unknown>(
      state.runId,
      "implementation-result.json",
    );
    if (!rawPlan || !rawImplementation) {
      throw new Error("Cannot resume without plan.json and implementation-result.json");
    }
    const validatedPlan = assertPlanArtifact(rawPlan);
    const implementation = assertImplementationResult(rawImplementation);

    let startFrom: "verifying" | "reviewing" | "publishing" = "verifying";
    if (state.status === "awaiting_human") {
      return {
        runId: state.runId,
        status: state.status,
        implementation,
        verification:
          (await deps.runStore.readArtifact<VerificationResult>(state.runId, "verification.json")) ??
          undefined,
        review:
          (await deps.runStore.readArtifact<ReviewArtifact>(state.runId, "review.json")) ??
          undefined,
        pullRequestNumber: state.pullRequestNumber,
        published: true,
        reasons: ["Run already completed and is awaiting human review; publish will not be repeated"],
      };
    }
    if (
      state.status === "publishing" &&
      state.completedSteps.includes("reviewing") &&
      implementation.publishable &&
      implementation.status === "completed"
    ) {
      startFrom = "publishing";
    } else if (
      state.status === "reviewing" ||
      (state.completedSteps.includes("verifying") && !state.completedSteps.includes("reviewing"))
    ) {
      startFrom = "reviewing";
    } else if (state.completedSteps.includes("reviewing") && state.status === "blocked") {
      // Re-enter review/fix loop rather than publishing a blocked review.
      startFrom = "reviewing";
    }

    return runVerifyReviewPublish({
      deps,
      state,
      delivery: input,
      implementation,
      plan: validatedPlan,
      issue,
      startFrom,
    });
  } finally {
    await deps.runStore.releaseLock({
      repository: state.repository,
      issueNumber: state.issueNumber,
    }).catch(() => undefined);
  }
}

function assertPlanArtifact(value: unknown): PlanArtifact {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid plan.json artifact");
  }
  const plan = value as PlanArtifact;
  if (
    plan.artifactType !== "implementation-plan" ||
    typeof plan.summary !== "string" ||
    !Array.isArray(plan.steps) ||
    !Array.isArray(plan.acceptanceCriteria)
  ) {
    throw new Error("Invalid plan.json artifact shape");
  }
  return plan;
}

function assertImplementationResult(value: unknown): ImplementationResult {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid implementation-result.json artifact");
  }
  const result = value as ImplementationResult;
  const statuses = new Set([
    "completed",
    "blocked",
    "cancelled",
    "timed_out",
    "failed",
  ]);
  if (
    !statuses.has(result.status) ||
    typeof result.sessionId !== "string" ||
    typeof result.publishable !== "boolean" ||
    !Array.isArray(result.changedFiles) ||
    !Array.isArray(result.reportedFiles)
  ) {
    throw new Error("Invalid implementation-result.json artifact shape");
  }
  return result;
}
