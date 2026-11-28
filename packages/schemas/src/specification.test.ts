import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { buildSpecificationArtifacts, type SpecificationContent } from "@meguribi/core";
import { RequirementArtifactSchema } from "./require.js";
import { SpecificationArtifactSchema, SpecificationContentSchema } from "./specification.js";

const content: SpecificationContent = {
  problem: "problem",
  targetUsers: ["user"],
  requirements: [{ id: "REQ-1", statement: "requirement", priority: "must" }],
  acceptanceCriteria: [
    {
      id: "AC-1",
      seed: "seed",
      given: "given",
      when: "when",
      // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then の `then` はデータフィールドであり thenable ではない
      then: "then",
      requirementIds: ["REQ-1"],
    },
  ],
  inScope: ["in"], outOfScope: ["out"], testPlan: ["test"], successMetrics: [], guardrails: [], openQuestions: [],
};

describe("SpecificationContentSchema", () => {
  it("accepts valid specification content", () => {
    expect(v.safeParse(SpecificationContentSchema, content).success).toBe(true);
  });
  it("rejects missing Given/When/Then fields", () => {
    const invalid = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
    delete (invalid.acceptanceCriteria as Record<string, unknown>[])[0]!.given;
    expect(v.safeParse(SpecificationContentSchema, invalid).success).toBe(false);
  });

  it("rejects empty Given/When/Then or requirement statements", () => {
    const invalid = JSON.parse(JSON.stringify(content)) as {
      requirements: { statement: string }[];
      acceptanceCriteria: { given: string; when: string; then: string }[];
    };
    invalid.requirements[0]!.statement = "";
    invalid.acceptanceCriteria[0]!.given = "";
    invalid.acceptanceCriteria[0]!.when = "";
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then の `then` はデータフィールドであり thenable ではない
    invalid.acceptanceCriteria[0]!.then = "";
    expect(v.safeParse(SpecificationContentSchema, invalid).success).toBe(false);
  });
});

describe("SpecificationArtifactSchema", () => {
  it("accepts a valid persisted specification artifact", () => {
    const artifact = {
      schemaVersion: 1, artifactType: "specification", repository: "owner/repo", sourceIssueNumber: 96,
      sourceIssueUrl: "https://github.com/owner/repo/issues/96", runId: "run-1", conclusionHash: "hash",
      generatedAt: "2026-11-28T00:00:00.000Z", status: "draft", humanApprovalRequired: true,
      acceptanceCriteria: content.acceptanceCriteria, inScope: content.inScope, outOfScope: content.outOfScope,
      testPlan: content.testPlan, openQuestions: [],
    };
    expect(v.safeParse(SpecificationArtifactSchema, artifact).success).toBe(true);
  });
  it("rejects invalid artifact metadata", () => {
    const artifact = {
      schemaVersion: 1, artifactType: "specification", repository: "owner/repo", sourceIssueNumber: 0,
      sourceIssueUrl: "url", runId: "run-1", conclusionHash: "hash", generatedAt: "not-time", status: "draft",
      humanApprovalRequired: true, acceptanceCriteria: [], inScope: [], outOfScope: [], testPlan: [], openQuestions: [],
    };
    expect(v.safeParse(SpecificationArtifactSchema, artifact).success).toBe(false);
  });
});

describe("generated artifact compatibility", () => {
  it("accepts artifacts built by the core specification helper", () => {
    const result = buildSpecificationArtifacts({
      repository: "owner/repo",
      sourceIssueNumber: 96,
      sourceIssueUrl: "https://github.com/owner/repo/issues/96",
      runId: "run-1",
      approval: {
        decision: "approved",
        approver: "human",
        at: "2026-11-28T00:00:00.000Z",
        conclusionHash: "hash",
      },
      conclusion: {
        topic: "topic",
        conclusion: "approved direction",
        issues: [],
        rejectedOptions: [],
        openQuestions: [],
        acceptanceCriteriaSeeds: ["seed"],
        endedBy: "consensus",
        transcriptHash: "transcript",
      },
      content,
      generatedAt: "2026-11-28T01:00:00.000Z",
      conclusionHash: "hash",
    });
    expect(v.safeParse(RequirementArtifactSchema, result.requirement).success).toBe(true);
    expect(v.safeParse(SpecificationArtifactSchema, result.specification).success).toBe(true);
  });
});
