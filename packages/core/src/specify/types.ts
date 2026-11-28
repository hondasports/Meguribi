import type { RequirementArtifact } from "../require.js";

export interface SpecificationAcceptanceCriterion {
  id: string;
  seed: string;
  given: string;
  when: string;
  then: string;
  requirementIds: string[];
}

export interface SpecificationContent {
  problem: string | null;
  targetUsers: string[];
  requirements: RequirementArtifact["requirements"];
  acceptanceCriteria: SpecificationAcceptanceCriterion[];
  inScope: string[];
  outOfScope: string[];
  testPlan: string[];
  successMetrics: string[];
  guardrails: string[];
  openQuestions: string[];
}

export interface Specification {
  schemaVersion: 1;
  artifactType: "specification";
  repository: string;
  sourceIssueNumber: number;
  sourceIssueUrl: string;
  runId: string;
  conclusionHash: string;
  generatedAt: string;
  status: "draft";
  humanApprovalRequired: true;
  acceptanceCriteria: SpecificationAcceptanceCriterion[];
  inScope: string[];
  outOfScope: string[];
  testPlan: string[];
  openQuestions: string[];
}

export interface SpecifyArtifactsResult {
  requirement: RequirementArtifact;
  specification: Specification;
}
