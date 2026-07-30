import type { IssueRecord } from "./delivery.js";
import { discoverProblems } from "./discover.js";
import { describe, expect, it } from "vitest";

const issues: IssueRecord[] = [
  {
    number: 4,
    title: "入力が途中で止まる",
    body: "保存前に画面を閉じる利用者がいる。",
    labels: ["product:discovery"],
    comments: [{ id: 41, author: "user", body: "同じ問題を再現しました。" }],
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
  {
    number: 5,
    title: "入力が途中で止まる",
    body: "保存前に画面を閉じる利用者がいる。",
    labels: ["product:discovery"],
    comments: [],
    updatedAt: "2026-07-02T00:00:00.000Z",
  },
];

describe("discoverProblems", () => {
  it("separates reported observations from unmade inferences and saves candidates", async () => {
    let saved: unknown;
    const result = await discoverProblems(
      {
        repository: "owner/repo",
        since: "2026-07-01",
        label: "product:discovery",
        limit: 5,
        fileObservations: [{ id: "file:1", statement: "利用者からの報告", source: "notes.md", confidence: "unknown" }],
      },
      {
        github: { listIssues: async () => issues },
        artifactStore: {
          save: async ({ artifact }) => {
            saved = artifact;
            return "C:/data/discoveries/owner/repo/discovery.json";
          },
        },
        now: () => new Date("2026-07-03T00:00:00.000Z"),
      },
    );

    expect(result.artifactPath).toContain("discovery.json");
    expect(result.artifact.observations.some((observation) => observation.confidence === "reported")).toBe(true);
    expect(result.artifact.problemCandidates).toHaveLength(4);
    expect(result.artifact.problemCandidates[0]?.inferences).toEqual([]);
    expect(result.artifact.problemCandidates[0]?.missingInformation).toContain("root cause");
    expect(result.artifact.problemCandidates[0]?.ranking.rationale).toContain("not a product-priority");
    expect(saved).toEqual(result.artifact);
  });

  it("rejects unsafe discovery bounds", async () => {
    const deps = {
      github: { listIssues: async () => [] },
      artifactStore: { save: async () => "unused" },
    };
    await expect(discoverProblems({ repository: "owner/repo", since: "0d" }, deps)).rejects.toThrow("between 1d");
    await expect(discoverProblems({ repository: "owner/repo", limit: 101 }, deps)).rejects.toThrow("between 1 and 100");
  });
});
