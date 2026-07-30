import type { PlanArtifact } from "../codex-artifact.js";
import type { PlanDependencies, PlanInput, PlanResult } from "../plan.js";

export const IMPLEMENTATION_PLAN_MARKER = "<!-- meguribi:implementation-plan -->";

export async function planIssue(
  input: PlanInput,
  deps: PlanDependencies,
): Promise<PlanResult> {
  const issue = await deps.github.getIssue(input.repository, input.issueNumber);
  const plan = assertPlanArtifact(
    await deps.codex.createPlan({
      repositoryPath: input.repositoryPath,
      issue,
      userRequest: input.userRequest,
      repositoryRules: input.repositoryRules,
      completionCriteria: input.completionCriteria,
      outOfScope: input.outOfScope,
    }),
  );
  const artifactPath = await deps.planStore.save({
    repository: input.repository,
    issueNumber: input.issueNumber,
    plan,
  });
  const comment = await deps.github.upsertMarkerComment({
    repository: input.repository,
    issueNumber: input.issueNumber,
    marker: IMPLEMENTATION_PLAN_MARKER,
    body: renderPlanComment(plan),
  });

  return {
    repository: input.repository,
    issueNumber: input.issueNumber,
    plan,
    artifactPath,
    commentId: comment.commentId,
  };
}

function renderPlanComment(plan: PlanArtifact): string {
  return [
    IMPLEMENTATION_PLAN_MARKER,
    "## Meguribi Implementation Plan",
    "",
    plan.summary,
    "",
    "### Requirements",
    renderItems(plan.requirements),
    "",
    "### Acceptance criteria",
    renderItems(plan.acceptanceCriteria),
    "",
    "### Proposed steps",
    renderItems(plan.steps),
    "",
    "### Proposed files",
    renderItems(plan.proposedFiles),
    "",
    "### Tests",
    renderItems(plan.tests),
    "",
    "### Risks",
    renderItems(plan.risks),
    "",
    "### Human decisions",
    renderItems(plan.humanDecisions),
    "",
    "### Out of scope",
    renderItems(plan.outOfScope),
    "",
    "### Unresolved items",
    renderItems(plan.unresolvedItems),
  ].join("\n");
}

function renderItems(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function assertPlanArtifact(value: PlanArtifact): PlanArtifact {
  if (
    value.schemaVersion !== 1 ||
    value.artifactType !== "implementation-plan" ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.requirements) ||
    !Array.isArray(value.acceptanceCriteria) ||
    !Array.isArray(value.outOfScope) ||
    !Array.isArray(value.proposedFiles) ||
    !Array.isArray(value.steps) ||
    !Array.isArray(value.risks) ||
    !Array.isArray(value.tests) ||
    !Array.isArray(value.humanDecisions) ||
    !Array.isArray(value.unresolvedItems) ||
    !value.metadata
  ) {
    throw new Error("Codex returned an invalid implementation plan");
  }
  return value;
}
