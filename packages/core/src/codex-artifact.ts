export type CodexArtifactRole = "planner" | "reviewer";

export interface CodexEventRecord {
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface CodexArtifactMetadata {
  schemaVersion: 1;
  artifactId: string;
  createdAt: string;
  durationMs: number;
  producer: {
    kind: "codex";
    role: CodexArtifactRole;
    threadId: string;
  };
  sourceDigests: Record<string, string>;
  eventLog: CodexEventRecord[];
}

export interface PlanContent {
  summary: string;
  requirements: string[];
  acceptanceCriteria: string[];
  outOfScope: string[];
  proposedFiles: string[];
  steps: string[];
  risks: string[];
  tests: string[];
  humanDecisions: string[];
  unresolvedItems: string[];
}

export interface PlanArtifact extends PlanContent {
  schemaVersion: 1;
  artifactType: "implementation-plan";
  metadata: CodexArtifactMetadata;
}

export type ReviewStatus = "approved" | "approved_with_notes" | "changes_required" | "blocked";

export type ReviewCoverageStatus = "covered" | "partial" | "missing";

export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface ReviewRequirementCoverage {
  requirementId: string;
  status: ReviewCoverageStatus;
  evidence: string[];
}

export interface ReviewFinding {
  id: string;
  severity: ReviewFindingSeverity;
  path?: string;
  line?: number;
  problem: string;
  requiredChange: string;
}

export interface ReviewContent {
  status: ReviewStatus;
  summary: string;
  requirementCoverage: ReviewRequirementCoverage[];
  findings: ReviewFinding[];
  missingTests: string[];
  scopeViolations: string[];
  recommendedAction: "proceed" | "fix" | "block";
}

export interface ReviewArtifact extends ReviewContent {
  schemaVersion: 1;
  artifactType: "code-review";
  metadata: CodexArtifactMetadata;
}
