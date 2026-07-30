import { describe, expect, it } from "vitest";
import { exploreSolutions } from "./explore.js";

describe("exploreSolutions", () => {
  it("compares multiple explicit options without selecting a winner", async () => {
    const result = await exploreSolutions({ repository: "owner/repo", issueNumber: 12 }, {
      github: {
        getIssue: async () => ({ number: 12, title: "Problem", body: "## 解決方針\n- 入力を減らす\n- 下書きを保存する", labels: ["type:problem"], comments: [], updatedAt: "2026-07-30T00:00:00.000Z" }),
        upsertMarkerComment: async (input) => { expect(input.marker).toBe("<!-- meguribi:explore -->"); return { commentId: 4 }; },
      },
      artifactStore: { save: async () => "explore.json" },
    });
    expect(result.artifact.options).toHaveLength(2);
    expect(result.artifact.options[0]?.implementationCost).toBeNull();
    expect(result.artifact.selectedOptionId).toBeNull();
    expect(result.artifact.humanApprovalRequired).toBe(true);
  });

  it("rejects a single option instead of inventing an alternative", async () => {
    await expect(exploreSolutions({ repository: "owner/repo", issueNumber: 12 }, {
      github: { getIssue: async () => ({ number: 12, title: "Problem", body: "## 解決方針\n- one", labels: [], comments: [], updatedAt: "2026-07-30T00:00:00.000Z" }), upsertMarkerComment: async () => ({ commentId: 1 }) },
      artifactStore: { save: async () => "explore.json" },
    })).rejects.toThrow(/at least two/);
  });
});
