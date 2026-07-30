import { describe, expect, it } from "vitest";
import { promoteHypothesis } from "./promote.js";

const issue = (labels: string[] = ["product:validated"]) => ({
  number: 12,
  title: "Registration drop-off",
  body: "## 観測\n- 離脱が報告された\n## 課題候補\n- 登録を完了できない利用者がいる",
  labels,
  comments: [],
  updatedAt: "2026-07-30T00:00:00.000Z",
});

describe("promoteHypothesis", () => {
  it("stops without the human validation label", async () => {
    await expect(promoteHypothesis({ repository: "owner/repo", issueNumber: 12 }, {
      github: {
        getIssue: async () => issue([]),
        upsertMarkerComment: async () => ({ commentId: 1 }),
        createIssue: async () => ({ number: 13, url: "local://issues/13" }),
      },
      artifactStore: { save: async () => "problem.json" },
    })).rejects.toThrow(/product:validated/);
  });

  it("preserves evidence, does not select a solution, and requires confirmation to create", async () => {
    let created = false;
    const result = await promoteHypothesis({
      repository: "owner/repo",
      issueNumber: 12,
      createIssue: true,
      confirmCreateIssue: async () => true,
    }, {
      github: {
        getIssue: async () => issue(),
        upsertMarkerComment: async () => ({ commentId: 2 }),
        createIssue: async () => { created = true; return { number: 13, url: "https://github.com/owner/repo/issues/13" }; },
      },
      artifactStore: { save: async () => "problem.json" },
      now: () => new Date("2026-07-30T01:00:00.000Z"),
    });
    expect(result.artifact.evidence).toEqual(["離脱が報告された"]);
    expect(result.artifact.targetUser).toBeNull();
    expect(result.createdIssue?.number).toBe(13);
    expect(created).toBe(true);
  });
});
