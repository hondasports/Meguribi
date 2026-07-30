import type {
  PlanArtifact,
  ReviewArtifact,
} from "./codex-artifact.js";
import type {
  DeliveryDependencies,
  GitAdapter,
  GitHubAdapter,
  ImplementationResult,
  RunState,
  RunStore,
  VerificationResult,
} from "./delivery.js";

export interface ReviewDependencies {
  github: Pick<GitHubAdapter, "getIssue" | "upsertMarkerComment">;
  git: Pick<GitAdapter, "getIdentity" | "getDiff">;
  codex: Pick<DeliveryDependencies["codex"], "review">;
  runStore: Pick<RunStore, "load" | "loadLatest" | "update" | "saveArtifact" | "readArtifact">;
}

export interface ReviewInput {
  repository: string;
  issueNumber: number;
  repositoryPath: string;
  repositoryRules: string;
  runId?: string;
}

export interface ReviewResult {
  repository: string;
  issueNumber: number;
  runId: string;
  branch: string;
  worktreePath: string;
  review: ReviewArtifact;
  artifactPath: string;
  commentId: number;
}

export const CODE_REVIEW_MARKER = "<!-- meguribi:code-review -->";

export async function reviewIssue(
  input: ReviewInput,
  deps: ReviewDependencies,
): Promise<ReviewResult> {
  const issue = await deps.github.getIssue(input.repository, input.issueNumber);
  const state = await loadReviewRun(input, deps);
  await assertReviewIdentity(state, deps);

  const plan = assertPlanArtifact(
    await deps.runStore.readArtifact<unknown>(state.runId, "plan.json"),
    state.runId,
  );
  assertImplementationResult(
    await deps.runStore.readArtifact<unknown>(state.runId, "implementation-result.json"),
    state.runId,
  );
  const verification = assertVerificationResult(
    await deps.runStore.readArtifact<unknown>(state.runId, "verification.json"),
    state.runId,
  );
  const diff = await deps.git.getDiff(state.worktreePath);
  const review = assertReviewArtifact(
    (await deps.codex.review({
      repositoryPath: input.repositoryPath,
      issue,
      plan,
      diff: diff.patch,
      changedFiles: diff.changedFiles,
      verification,
      repositoryRules: input.repositoryRules,
    })) as unknown,
  );
  const artifactPath = await deps.runStore.saveArtifact(state.runId, "review.json", review);
  await deps.runStore.update(state.runId, {
    agentSessions: {
      ...state.agentSessions,
      codexReview: review.metadata.producer.threadId,
    },
  });
  const comment = await deps.github.upsertMarkerComment({
    repository: input.repository,
    issueNumber: input.issueNumber,
    marker: CODE_REVIEW_MARKER,
    body: renderReviewComment(review),
  });

  return {
    repository: input.repository,
    issueNumber: input.issueNumber,
    runId: state.runId,
    branch: state.branch,
    worktreePath: state.worktreePath,
    review,
    artifactPath,
    commentId: comment.commentId,
  };
}

async function loadReviewRun(
  input: ReviewInput,
  deps: ReviewDependencies,
): Promise<RunState> {
  const state = input.runId
    ? await deps.runStore.load(input.runId)
    : await deps.runStore.loadLatest(input.repository, input.issueNumber);
  if (!state) {
    throw new Error(
      `No delivery Run found for ${input.repository}#${String(input.issueNumber)}; run an implementation first or pass --run-id`,
    );
  }
  if (state.repository !== input.repository || state.issueNumber !== input.issueNumber) {
    throw new Error(
      `Run ${state.runId} belongs to ${state.repository}#${String(state.issueNumber)}, not ${input.repository}#${String(input.issueNumber)}; pass the matching --run-id`,
    );
  }
  if (!state.completedSteps.includes("implementation_completed")) {
    throw new Error(
      `Run ${state.runId} has no completed implementation; review requires implementation-result.json and a completed worktree`,
    );
  }
  return state;
}

async function assertReviewIdentity(
  state: RunState,
  deps: ReviewDependencies,
): Promise<void> {
  const identity = await deps.git.getIdentity(state.worktreePath);
  if (
    identity.branch !== state.branch ||
    identity.headSha !== state.headSha ||
    identity.remoteIdentity !== state.remoteIdentity
  ) {
    throw new Error(
      `Review identity mismatch for Run ${state.runId}; restore branch, HEAD, remote, and worktree before retrying`,
    );
  }
}

function assertPlanArtifact(value: unknown, runId: string): PlanArtifact {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.artifactType !== "implementation-plan" ||
    typeof value.summary !== "string" ||
    !hasStringArray(value, "requirements") ||
    !hasStringArray(value, "acceptanceCriteria") ||
    !hasStringArray(value, "outOfScope") ||
    !hasStringArray(value, "proposedFiles") ||
    !hasStringArray(value, "steps") ||
    !hasStringArray(value, "risks") ||
    !hasStringArray(value, "tests") ||
    !hasStringArray(value, "humanDecisions") ||
    !hasStringArray(value, "unresolvedItems")
  ) {
    throw new Error(`Run ${runId} has an invalid plan.json; regenerate the plan before review`);
  }
  return value as unknown as PlanArtifact;
}

function assertImplementationResult(value: unknown, runId: string): ImplementationResult {
  if (!isRecord(value) || typeof value.status !== "string" || !hasStringArray(value, "changedFiles")) {
    throw new Error(
      `Run ${runId} has an invalid implementation-result.json; resume the Run to regenerate it`,
    );
  }
  return value as unknown as ImplementationResult;
}

function assertVerificationResult(value: unknown, runId: string): VerificationResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.artifactType !== "verification" ||
    typeof value.success !== "boolean" ||
    !Array.isArray(value.commands)
  ) {
    throw new Error(
      `Run ${runId} has an invalid verification.json; run verification before review`,
    );
  }
  return value as unknown as VerificationResult;
}

function assertReviewArtifact(value: unknown): ReviewArtifact {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.artifactType !== "code-review" ||
    !["approved", "approved_with_notes", "changes_required", "blocked"].includes(String(value.status)) ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.findings) ||
    !Array.isArray(value.requirementCoverage) ||
    !Array.isArray(value.missingTests) ||
    !Array.isArray(value.scopeViolations) ||
    !value.metadata
  ) {
    throw new Error("Codex returned an invalid code review artifact");
  }
  return value as unknown as ReviewArtifact;
}

function renderReviewComment(review: ReviewArtifact): string {
  return [
    CODE_REVIEW_MARKER,
    "## Meguribi Code Review",
    "",
    `**Status:** ${review.status}`,
    "",
    review.summary,
    "",
    "### Findings",
    review.findings.length > 0
      ? review.findings.map((finding) => {
          const location = finding.path
            ? ` (${finding.path}${finding.line ? `:${String(finding.line)}` : ""})`
            : "";
          return `- **${finding.severity}**${location}: ${finding.problem} — ${finding.requiredChange}`;
        }).join("\n")
      : "- None",
    "",
    "### Missing tests",
    renderItems(review.missingTests),
    "",
    "### Scope violations",
    renderItems(review.scopeViolations),
    "",
    `**Recommended action:** ${review.recommendedAction}`,
  ].join("\n");
}

function renderItems(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasStringArray(value: Record<string, unknown>, key: string): boolean {
  return Array.isArray(value[key]) && value[key].every((item) => typeof item === "string");
}
