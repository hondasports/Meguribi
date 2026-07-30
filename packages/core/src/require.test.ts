import { describe, expect, it } from "vitest";
import { requireSolution } from "./require.js";
describe("requireSolution", () => {
  it("selects only an explicit approved solution and leaves missing requirements open", async () => {
    const result = await requireSolution({ repository: "owner/repo", issueNumber: 12, solutionNumber: 2 }, { github: { getIssue: async () => ({ number: 12, title: "Problem", body: "## 課題候補\n- problem\n## 解決方針\n- A\n- B", labels: ["product:approved"], comments: [], updatedAt: "2026-07-30T00:00:00.000Z" }), upsertMarkerComment: async () => ({ commentId: 2 }) }, artifactStore: { save: async () => "requirements.json" } });
    expect(result.artifact.selectedSolution.statement).toBe("B"); expect(result.artifact.requirements).toEqual([]); expect(result.artifact.humanApprovalRequired).toBe(true);
  });
  it("fails closed without approval", async () => {
    await expect(requireSolution({ repository: "owner/repo", issueNumber: 12, solutionNumber: 1 }, { github: { getIssue: async () => ({ number: 12, title: "Problem", body: "## 解決方針\n- A", labels: [], comments: [], updatedAt: "2026-07-30T00:00:00.000Z" }), upsertMarkerComment: async () => ({ commentId: 1 }) }, artifactStore: { save: async () => "requirements.json" } })).rejects.toThrow(/product:approved/);
  });
});
