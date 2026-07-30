import { describe, expect, it } from "vitest";
import { runHypothesisCommand } from "./hypothesis.js";

describe("runHypothesisCommand", () => {
  it("structures an Issue and prints JSON without requiring agent diagnostics", async () => {
    const output: string[] = [];
    const result = await runHypothesisCommand(
      "owner/repo#12",
      { json: true, repoPath: "C:/fixture/repository" },
      {
        cwd: "C:/fixture/repository",
        stdout: (text) => output.push(text),
        hypothesis: {
          github: {
            getIssue: async () => ({
              number: 12,
              title: "Hypothesis",
              body: "## 観測\n- 利用者が離脱する",
              labels: [],
              comments: [],
              updatedAt: "2026-07-30T00:00:00.000Z",
            }),
            upsertMarkerComment: async (input) => {
              expect(input.marker).toBe("<!-- meguribi:hypothesis -->");
              return { commentId: 4 };
            },
          },
          artifactStore: { save: async () => "C:/data/hypothesis.json" },
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(output.join("")).artifact.artifactType).toBe("hypothesis");
  });
});
