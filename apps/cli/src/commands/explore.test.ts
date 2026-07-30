import { describe, expect, it } from "vitest";
import { runExploreCommand } from "./explore.js";
describe("runExploreCommand", () => {
  it("prints a solution comparison artifact", async () => {
    const output: string[] = [];
    const result = await runExploreCommand("owner/repo#12", { json: true }, { stdout: (text) => output.push(text), explore: { github: { getIssue: async () => ({ number: 12, title: "Problem", body: "## 解決方針\n- A\n- B", labels: [], comments: [], updatedAt: "2026-07-30T00:00:00.000Z" }), upsertMarkerComment: async () => ({ commentId: 1 }) }, artifactStore: { save: async () => "exploration.json" } } });
    expect(result.exitCode).toBe(0); expect(JSON.parse(output.join("")).artifact.selectedOptionId).toBeNull();
  });
});
