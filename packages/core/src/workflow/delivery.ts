import type { AgentError } from "../agent-error.js";
import type {
  DeliveryDependencies,
  DeliveryResult,
  DeliveryStep,
  ImplementationResult,
  ResumeDeliveryInput,
  RunDeliveryInput,
  RunState,
  RunStatus,
  VerificationResult,
} from "../delivery.js";
import type { PlanArtifact, ReviewArtifact } from "../codex-artifact.js";
import { decideInheritedMcpPolicy } from "../mcp-policy.js";
import { runWorkflow } from "../workflow-engine/engine.js";
import { createRunStoreStepStateStore } from "../workflow-engine/run-store-step-state.js";
import { createDeliveryWorkflow } from "./delivery-definition.js";
import {
  appendStep,
  cancelledResult,
  createDeliveryStepHandlers,
  createVerificationLogWriter,
  evaluatePublishGate,
  isCancelledError,
  mark,
  runDeliveryFixAttempt,
  type DeliveryRunContext,
} from "./delivery-steps.js";

export { evaluatePublishGate } from "./delivery-steps.js";
export type { PublishGateInput } from "./delivery-steps.js";

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

async function assertIdentity(deps: DeliveryDependencies, state: RunState): Promise<void> {
  const identity = await deps.git.getIdentity(state.worktreePath);
  if (
    identity.branch !== state.branch ||
    identity.headSha !== state.headSha ||
    identity.remoteIdentity !== state.remoteIdentity
  ) {
    throw Object.assign(
      new Error("Run identity mismatch: worktree/branch/HEAD/remote do not match saved state"),
      {
        code: "policy_blocked",
        message: "Run identity mismatch: worktree/branch/HEAD/remote do not match saved state",
        isRetryable: false,
      } satisfies AgentError,
    );
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
    (await deps.runStore.readArtifact<VerificationResult>(state.runId, "verification.json")) ??
    undefined;
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
  const context: DeliveryRunContext = {
    deps: input.deps,
    delivery: input.delivery,
    state: input.state,
    issue: input.issue,
    plan: input.plan,
    implementation: input.previousImplementation,
    verification: input.verification,
    review: input.review,
    reuseVerification: false,
  };
  await runDeliveryFixAttempt(context);
  return {
    state: context.state,
    implementation: context.implementation ?? input.previousImplementation,
    verification: context.verification ?? input.verification,
    review: context.review,
  };
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

  let lockReleased = false;
  const releaseLock = async (): Promise<void> => {
    if (lockReleased) {
      return;
    }
    lockReleased = true;
    await deps.runStore
      .releaseLock({
        repository: input.repository,
        issueNumber: input.issueNumber,
      })
      .catch(() => undefined);
  };

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

    const context: DeliveryRunContext = {
      deps,
      delivery: input,
      state: current,
      issue,
      reuseVerification: false,
    };
    const workflowResult = await runWorkflow<DeliveryRunContext, DeliveryResult>({
      runId: current.runId,
      definition: createDeliveryWorkflow(input.maxFixAttempts),
      handlers: createDeliveryStepHandlers({ releaseLock }),
      context,
      stepStore: createRunStoreStepStateStore(deps.runStore, current.runId),
      onEvent: deps.onWorkflowEvent,
      now: deps.now,
    });
    if (workflowResult.type === "stopped") {
      return workflowResult.result;
    }
    throw new Error(`delivery workflow ended without a result: ${workflowResult.type}`);
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
    await releaseLock();
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
  const state = input.runId
    ? await deps.runStore.load(input.runId)
    : await deps.runStore.loadLatest(input.repository, input.issueNumber);
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
          (await deps.runStore.readArtifact<VerificationResult>(
            state.runId,
            "verification.json",
          )) ?? undefined,
        review:
          (await deps.runStore.readArtifact<ReviewArtifact>(state.runId, "review.json")) ??
          undefined,
        pullRequestNumber: state.pullRequestNumber,
        published: true,
        reasons: [
          "Run already completed and is awaiting human review; publish will not be repeated",
        ],
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
    await deps.runStore
      .releaseLock({
        repository: state.repository,
        issueNumber: state.issueNumber,
      })
      .catch(() => undefined);
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
  const statuses = new Set(["completed", "blocked", "cancelled", "timed_out", "failed"]);
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
