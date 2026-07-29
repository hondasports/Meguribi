import type { PlanArtifact } from "./codex-artifact.js";
import type { DeliveryDependencies, GitHubAdapter } from "./delivery.js";

export interface PlanArtifactStore {
  save(input: {
    repository: string;
    issueNumber: number;
    plan: PlanArtifact;
  }): Promise<string>;
}

export interface PlanDependencies {
  github: Pick<GitHubAdapter, "getIssue" | "upsertMarkerComment">;
  codex: Pick<DeliveryDependencies["codex"], "createPlan">;
  planStore: PlanArtifactStore;
}

export interface PlanInput {
  repository: string;
  issueNumber: number;
  repositoryPath: string;
  repositoryRules: string;
  completionCriteria: string[];
  outOfScope: string[];
}

export interface PlanResult {
  repository: string;
  issueNumber: number;
  plan: PlanArtifact;
  artifactPath: string;
  commentId: number;
}
