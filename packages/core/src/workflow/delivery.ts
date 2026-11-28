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
  createDeliveryStepHandlers,
  mark,
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

  const releaseLock = async (): Promise<void> => {
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
      handlers: createDeliveryStepHandlers(),
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

  const releaseLock = async (): Promise<void> => {
    await deps.runStore
      .releaseLock({
        repository: state.repository,
        issueNumber: state.issueNumber,
      })
      .catch(() => undefined);
  };

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

    const context: DeliveryRunContext = {
      deps,
      delivery: input,
      state,
      issue,
      plan: validatedPlan,
      implementation,
      reuseVerification: startFrom === "reviewing",
    };
    const workflowResult = await runWorkflow<DeliveryRunContext, DeliveryResult>({
      runId: state.runId,
      definition: createDeliveryWorkflow(state.maxFixAttempts),
      handlers: createDeliveryStepHandlers(),
      context,
      startAt: startFrom === "publishing" ? "publish" : "verify",
      stepStore: createRunStoreStepStateStore(deps.runStore, state.runId),
      onEvent: deps.onWorkflowEvent,
      now: deps.now,
    });
    if (workflowResult.type === "stopped") {
      return workflowResult.result;
    }
    throw new Error(`delivery workflow ended without a result: ${workflowResult.type}`);
  } finally {
    await releaseLock();
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
