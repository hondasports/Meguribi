import { assertApprovedConclusion, type ApprovalRecord } from "../discussion/approval.js";
import type { DiscussionConclusion } from "../discussion/types.js";
import type { RunStore } from "../delivery.js";
import type { RequirementArtifact } from "../require.js";
import type {
  Specification,
  SpecificationAcceptanceCriterion,
  SpecificationContent,
  SpecifyArtifactsResult,
} from "./types.js";

export type {
  Specification,
  SpecificationAcceptanceCriterion,
  SpecificationContent,
  SpecifyArtifactsResult,
} from "./types.js";

export interface BuildSpecificationArtifactsInput {
  repository: string;
  sourceIssueNumber: number;
  sourceIssueUrl: string;
  runId: string;
  approval: ApprovalRecord | null;
  conclusion: DiscussionConclusion;
  content: SpecificationContent;
  generatedAt: string;
  conclusionHash: string;
}

export interface SeedTraceResult {
  acceptanceCriteria: SpecificationAcceptanceCriterion[];
  openQuestions: string[];
}

function acceptanceCriterionStatement(criterion: SpecificationAcceptanceCriterion): string {
  return `Given ${criterion.given}, when ${criterion.when}, then ${criterion.then}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export function traceAcceptanceCriteria(
  seeds: readonly string[],
  criteria: readonly SpecificationAcceptanceCriterion[],
): SeedTraceResult {
  const seedCounts = countValues(seeds);
  const criterionSeedCounts = countValues(criteria.map((criterion) => criterion.seed));
  const seedSet = new Set(seeds);
  const traceableSeeds = new Set(
    unique(seeds).filter(
      (seed) => seedCounts.get(seed) === 1 && criterionSeedCounts.get(seed) === 1,
    ),
  );
  const acceptanceCriteria = criteria.filter((criterion) => traceableSeeds.has(criterion.seed));
  const openQuestions: string[] = [];

  for (const seed of unique(seeds)) {
    const matches = criterionSeedCounts.get(seed) ?? 0;
    if ((seedCounts.get(seed) ?? 0) > 1) {
      openQuestions.push(`Acceptance criteria seed is duplicated in conclusion: ${seed}`);
    } else if (matches === 0) {
      openQuestions.push(`No acceptance criterion covers seed: ${seed}`);
    } else if (matches > 1) {
      openQuestions.push(`Acceptance criteria for seed are ambiguous: ${seed}`);
    }
  }
  for (const criterion of criteria) {
    if (!seedSet.has(criterion.seed)) {
      openQuestions.push(
        `Acceptance criterion ${criterion.id} does not match any acceptanceCriteriaSeed: ${criterion.seed}`,
      );
    }
  }
  return { acceptanceCriteria, openQuestions };
}


function filterRequirementReferences(
  criteria: readonly SpecificationAcceptanceCriterion[],
  requirements: readonly { id: string }[],
): { acceptanceCriteria: SpecificationAcceptanceCriterion[]; openQuestions: string[] } {
  const validRequirementIds = new Set(requirements.map((requirement) => requirement.id));
  const openQuestions: string[] = [];
  const acceptanceCriteria = criteria.map((criterion) => {
    const requirementIds: string[] = [];
    for (const requirementId of criterion.requirementIds) {
      if (validRequirementIds.has(requirementId)) {
        if (!requirementIds.includes(requirementId)) {
          requirementIds.push(requirementId);
        }
      } else {
        openQuestions.push(
          `Acceptance criterion ${criterion.id} references unknown requirement: ${requirementId}`,
        );
      }
    }
    return { ...criterion, requirementIds };
  });
  return { acceptanceCriteria, openQuestions };
}

export function buildSpecificationArtifacts(input: BuildSpecificationArtifactsInput): SpecifyArtifactsResult {
  assertApprovedConclusion({
    approval: input.approval,
    currentConclusionHash: input.conclusionHash,
  });
  const traced = traceAcceptanceCriteria(
    input.conclusion.acceptanceCriteriaSeeds,
    input.content.acceptanceCriteria,
  );
  const requirementReferences = filterRequirementReferences(
    traced.acceptanceCriteria,
    input.content.requirements,
  );
  const openQuestions = unique([
    ...input.content.openQuestions,
    ...traced.openQuestions,
    ...requirementReferences.openQuestions,
  ]);
  const requirement: RequirementArtifact = {
    schemaVersion: 1,
    artifactType: "requirements",
    repository: input.repository,
    sourceIssueNumber: input.sourceIssueNumber,
    sourceIssueUrl: input.sourceIssueUrl,
    generatedAt: input.generatedAt,
    status: "draft",
    humanApprovalRequired: true,
    selectedSolution: { number: 1, statement: input.conclusion.conclusion },
    problem: input.content.problem,
    targetUsers: [...input.content.targetUsers],
    requirements: input.content.requirements.map((requirement) => ({ ...requirement })),
    acceptanceCriteria: requirementReferences.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      statement: acceptanceCriterionStatement(criterion),
      mapsTo: [...criterion.requirementIds],
    })),
    outOfScope: [...input.content.outOfScope],
    successMetrics: [...input.content.successMetrics],
    guardrails: [...input.content.guardrails],
    openQuestions: [...openQuestions],
    relatedIssues: { hypothesis: [], problem: [input.sourceIssueNumber] },
  };
  const specification: Specification = {
    schemaVersion: 1,
    artifactType: "specification",
    repository: input.repository,
    sourceIssueNumber: input.sourceIssueNumber,
    sourceIssueUrl: input.sourceIssueUrl,
    runId: input.runId,
    conclusionHash: input.conclusionHash,
    generatedAt: input.generatedAt,
    status: "draft",
    humanApprovalRequired: true,
    acceptanceCriteria: requirementReferences.acceptanceCriteria.map((criterion) => ({
      ...criterion,
      requirementIds: [...criterion.requirementIds],
    })),
    inScope: [...input.content.inScope],
    outOfScope: [...input.content.outOfScope],
    testPlan: [...input.content.testPlan],
    openQuestions: [...openQuestions],
  };
  return { requirement, specification };
}

export async function saveSpecificationArtifacts(
  runStore: Pick<RunStore, "saveArtifact">,
  runId: string,
  result: SpecifyArtifactsResult,
): Promise<{ requirementPath: string; specificationPath: string }> {
  const requirementPath = await runStore.saveArtifact(runId, "requirement.json", result.requirement);
  const specificationPath = await runStore.saveArtifact(runId, "specification.json", result.specification);
  return { requirementPath, specificationPath };
}
