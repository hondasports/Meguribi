import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  PlanArtifactSchema,
  PlanContentSchema,
  ReviewArtifactSchema,
  ReviewContentSchema,
} from "./codex-artifact.js";

const metadata = {
  schemaVersion: 1 as const,
  artifactId: "artifact-1",
  createdAt: "2026-07-26T00:00:00.000Z",
  durationMs: 10,
  producer: { kind: "codex" as const, role: "planner" as const, threadId: "thread-1" },
  sourceDigests: { issue: "sha256:issue" },
  eventLog: [
    {
      type: "thread.started",
      at: "2026-07-26T00:00:00.000Z",
      data: { thread_id: "thread-1" },
    },
  ],
};

const plan = {
  summary: "summary",
  requirements: ["requirement"],
  acceptanceCriteria: ["criterion"],
  outOfScope: ["out of scope"],
  proposedFiles: ["src/feature.ts"],
  steps: ["step"],
  risks: ["risk"],
  tests: ["test"],
  humanDecisions: ["decision"],
  unresolvedItems: [],
};

describe("Codex artifact schemas", () => {
  it("round-trips a plan artifact", () => {
    const artifact = {
      schemaVersion: 1 as const,
      artifactType: "implementation-plan" as const,
      metadata,
      ...plan,
    };
    const parsed = v.parse(PlanArtifactSchema, artifact);
    expect(v.parse(PlanArtifactSchema, JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects unknown top-level plan fields", () => {
    const result = v.safeParse(PlanContentSchema, { ...plan, unexpected: true });
    expect(result.success).toBe(false);
  });

  it("rejects invalid review status and severity", () => {
    const result = v.safeParse(ReviewContentSchema, {
      status: "approved_by_ai",
      summary: "summary",
      requirementCoverage: [],
      findings: [{ id: "F-1", severity: "urgent", problem: "problem", requiredChange: "fix" }],
      missingTests: [],
      scopeViolations: [],
      recommendedAction: "proceed",
    });
    expect(result.success).toBe(false);
  });

  it("requires metadata on a full review artifact", () => {
    const result = v.safeParse(ReviewArtifactSchema, {
      schemaVersion: 1,
      artifactType: "code-review",
      status: "approved",
      summary: "summary",
      requirementCoverage: [],
      findings: [],
      missingTests: [],
      scopeViolations: [],
      recommendedAction: "proceed",
    });
    expect(result.success).toBe(false);
  });
});
