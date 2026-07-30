import { describe, expect, it } from "vitest";
import { measureRelease } from "./measure.js";

describe("measureRelease", () => {
  it("creates an inconclusive post-release draft from an explicit merged PR", async () => {
    const result = await measureRelease({ repository: "owner/repo", issueNumber: 12, period: "14d" }, { now: () => new Date("2026-08-01T10:00:00.000Z"), github: { getIssue: async () => ({ number: 12, title: "Feature", body: "## 元の仮説\n- 完了率が改善する", labels: ["type:feature"], comments: [{ id: 3, author: "meguribi", body: "<!-- meguribi:delivery-summary -->\nDraft PR: #42" }], updatedAt: "2026-08-01T00:00:00.000Z" }), getPullRequest: async () => ({ number: 42, url: "https://github.com/owner/repo/pull/42", state: "closed", merged: true, head: "feature/42", headSha: "abc" }), upsertMarkerComment: async () => ({ commentId: 4 }) }, artifactStore: { save: async () => "measurement.json" } });
    expect(result.artifact.period).toEqual({ from: "2026-08-01", to: "2026-08-14" });
    expect(result.artifact.result).toBe("inconclusive");
    expect(result.artifact.originalHypothesis).toBe("完了率が改善する");
    expect(result.artifact.humanApprovalRequired).toBe(true);
  });

  it("fails closed when the PR is not merged", async () => {
    await expect(measureRelease({ repository: "owner/repo", issueNumber: 12, period: "14d" }, { github: { getIssue: async () => ({ number: 12, title: "Feature", body: "", labels: [], comments: [{ id: 3, author: "meguribi", body: "Draft PR: #42" }], updatedAt: "2026-08-01T00:00:00.000Z" }), getPullRequest: async () => ({ number: 42, url: "https://github.com/owner/repo/pull/42", state: "open", merged: false, head: "feature/42", headSha: "abc" }), upsertMarkerComment: async () => ({ commentId: 4 }) }, artifactStore: { save: async () => "measurement.json" } })).rejects.toThrow(/merged Pull Request/);
  });
});
