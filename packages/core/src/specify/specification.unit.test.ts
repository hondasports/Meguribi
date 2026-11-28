import { describe, expect, it } from "vitest";
import type { ApprovalRecord, DiscussionConclusion, RunStore } from "../index.js";
import {
  buildSpecificationArtifacts,
  saveSpecificationArtifacts,
  type SpecificationAcceptanceCriterion,
  type SpecificationContent,
} from "./specification.js";

function criterion(input: {
  id?: string;
  seed: string;
  requirementIds?: string[];
}): SpecificationAcceptanceCriterion {
  return {
    id: input.id ?? "AC-1",
    seed: input.seed,
    given: "夜間",
    when: "通知が届く",
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then の `then` はデータフィールドであり thenable ではない
    then: "即時通知しない",
    requirementIds: input.requirementIds ?? ["REQ-1"],
  };
}

const conclusion: DiscussionConclusion = {
  topic: "通知",
  conclusion: "朝にまとめる",
  issues: [],
  rejectedOptions: [],
  openQuestions: [],
  acceptanceCriteriaSeeds: ["夜間は通知しない", "朝に一覧化する"],
  endedBy: "consensus",
  transcriptHash: "t",
};
const approval: ApprovalRecord = {
  decision: "approved",
  approver: "human",
  at: "2026-11-28T00:00:00.000Z",
  conclusionHash: "hash",
};
const content: SpecificationContent = {
  problem: "夜間通知が煩い",
  targetUsers: ["個人"],
  requirements: [{ id: "REQ-1", statement: "通知をまとめられる", priority: "must" }],
  acceptanceCriteria: [criterion({ seed: "夜間は通知しない" })],
  inScope: ["通知"],
  outOfScope: ["音声"],
  testPlan: ["unit"],
  successMetrics: [],
  guardrails: [],
  openQuestions: ["既存質問"],
};
const input = {
  repository: "owner/repo",
  sourceIssueNumber: 96,
  sourceIssueUrl: "https://github.com/owner/repo/issues/96",
  runId: "run-1",
  approval,
  conclusion,
  content,
  generatedAt: "2026-11-28T01:00:00.000Z",
  conclusionHash: "hash",
};

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("buildSpecificationArtifacts", () => {
  it("builds requirement and specification artifacts with seed trace and uncovered seeds as openQuestions", () => {
    const result = buildSpecificationArtifacts(input);
    expect(result.requirement.artifactType).toBe("requirements");
    expect(result.requirement.acceptanceCriteria[0]).toMatchObject({ id: "AC-1", mapsTo: ["REQ-1"] });
    expect(result.specification.artifactType).toBe("specification");
    expect(result.specification.runId).toBe("run-1");
    expect(result.specification.conclusionHash).toBe("hash");
    expect(result.specification.acceptanceCriteria[0]?.seed).toBe("夜間は通知しない");
    expect(result.specification.openQuestions).toContain("既存質問");
    expect(result.specification.openQuestions).toContain(
      "No acceptance criterion covers seed: 朝に一覧化する",
    );
  });

  it("throws conclusion_hash_mismatch before building artifacts", () => {
    expect(errorCode(() => buildSpecificationArtifacts({ ...input, conclusionHash: "changed" }))).toBe(
      "conclusion_hash_mismatch",
    );
  });

  it("throws not_awaiting_approval without an approved conclusion", () => {
    expect(errorCode(() => buildSpecificationArtifacts({ ...input, approval: null }))).toBe("not_awaiting_approval");
  });

  it("moves criteria without a matching seed to openQuestions instead of guessing", () => {
    const bad = {
      ...content,
      acceptanceCriteria: [criterion({ seed: "unknown" })],
    };
    const result = buildSpecificationArtifacts({ ...input, content: bad });
    expect(result.specification.acceptanceCriteria).toEqual([]);
    expect(result.requirement.acceptanceCriteria).toEqual([]);
    expect(result.specification.openQuestions).toContain(
      "Acceptance criterion AC-1 does not match any acceptanceCriteriaSeed: unknown",
    );
    expect(result.specification.openQuestions).toContain(
      "No acceptance criterion covers seed: 夜間は通知しない",
    );
  });

  it("does not choose arbitrarily between duplicate criteria for one seed", () => {
    const duplicated = {
      ...content,
      acceptanceCriteria: [
        criterion({ id: "AC-1", seed: "夜間は通知しない" }),
        criterion({ id: "AC-2", seed: "夜間は通知しない" }),
      ],
    };
    const result = buildSpecificationArtifacts({ ...input, content: duplicated });
    expect(result.specification.acceptanceCriteria).toEqual([]);
    expect(result.specification.openQuestions).toContain(
      "Acceptance criteria for seed are ambiguous: 夜間は通知しない",
    );
  });

  it("drops unknown requirement references and records them as openQuestions", () => {
    const dangling = {
      ...content,
      acceptanceCriteria: [criterion({ seed: "夜間は通知しない", requirementIds: ["REQ-UNKNOWN"] })],
    };
    const result = buildSpecificationArtifacts({ ...input, content: dangling });
    expect(result.specification.acceptanceCriteria[0]?.requirementIds).toEqual([]);
    expect(result.requirement.acceptanceCriteria[0]?.mapsTo).toEqual([]);
    expect(result.specification.openQuestions).toContain(
      "Acceptance criterion AC-1 references unknown requirement: REQ-UNKNOWN",
    );
  });

  it("does not treat a duplicated conclusion seed as a one-to-one mapping", () => {
    const duplicatedSeedConclusion = {
      ...conclusion,
      acceptanceCriteriaSeeds: ["夜間は通知しない", "夜間は通知しない"],
    };
    const result = buildSpecificationArtifacts({ ...input, conclusion: duplicatedSeedConclusion });
    expect(result.specification.acceptanceCriteria).toEqual([]);
    expect(result.specification.openQuestions).toContain(
      "Acceptance criteria seed is duplicated in conclusion: 夜間は通知しない",
    );
  });
});

describe("saveSpecificationArtifacts", () => {
  it("saves requirement.json and specification.json through RunStore", async () => {
    const saved: Record<string, unknown> = {};
    const runStore = {
      saveArtifact: async (_runId: string, name: string, value: unknown) => {
        saved[name] = value;
        return `memory/${name}`;
      },
    } as Pick<RunStore, "saveArtifact">;
    const result = buildSpecificationArtifacts(input);
    const paths = await saveSpecificationArtifacts(runStore, "run-1", result);
    expect(paths).toEqual({
      requirementPath: "memory/requirement.json",
      specificationPath: "memory/specification.json",
    });
    expect(saved["requirement.json"]).toBe(result.requirement);
    expect(saved["specification.json"]).toBe(result.specification);
  });
});
