import type {
  ImplementationResult,
  PolicyEngine,
  PublishDecision,
  ReviewStatus,
  VerificationResult,
} from "@meguribi/core";
import { evaluatePublishGate, matchesProtectedPath } from "@meguribi/core";

/**
 * Minimal PolicyEngine used by CLI delivery wiring and fixture tests.
 */
export function createDefaultPolicyEngine(): PolicyEngine {
  return {
    async assertReady(input) {
      if (input.requiredLabels.length === 0) {
        throw new Error(
          "requiredLabels must not be empty; refusing fail-open readiness check",
        );
      }
      const missing = input.requiredLabels.filter((label) => !input.labels.includes(label));
      if (missing.length > 0) {
        throw new Error(`Missing required labels: ${missing.join(", ")}`);
      }
    },
    async evaluatePublish(input: {
      implementation: ImplementationResult;
      verification: VerificationResult;
      reviewStatus: ReviewStatus;
      protectedPaths: readonly string[];
    }): Promise<PublishDecision> {
      const gate = evaluatePublishGate({
        implementation: input.implementation,
        verification: input.verification,
        review: {
          schemaVersion: 1,
          artifactType: "code-review",
          status: input.reviewStatus,
          summary: "",
          requirementCoverage: [],
          findings: [],
          missingTests: [],
          scopeViolations: [],
          recommendedAction: input.reviewStatus === "changes_required" ? "fix" : "proceed",
          metadata: {
            schemaVersion: 1,
            artifactId: "policy-gate",
            createdAt: new Date().toISOString(),
            durationMs: 0,
            producer: { kind: "codex", role: "reviewer", threadId: "policy" },
            sourceDigests: {},
            eventLog: [],
          },
        },
        protectedPaths: input.protectedPaths,
      });
      const hits = input.implementation.changedFiles.filter((file) =>
        matchesProtectedPath(file, input.protectedPaths),
      );
      const reasons = [...gate.reasons];
      if (hits.length > 0 && !reasons.some((reason) => reason.includes("protected path"))) {
        reasons.push(`protected path changed without approval: ${hits.join(", ")}`);
      }
      return { allowed: reasons.length === 0, reasons };
    },
  };
}
