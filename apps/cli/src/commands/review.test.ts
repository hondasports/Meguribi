import type { ReviewResult } from "@meguribi/core";
import { describe, expect, it } from "vitest";
import { runReviewCommand } from "./review.js";

const result: ReviewResult = {
  repository: "owner/repo",
  issueNumber: 8,
  runId: "20260730T000000Z-review1",
  branch: "meguribi/issue-8",
  worktreePath: "C:/worktrees/issue-8",
  review: {
    schemaVersion: 1,
    artifactType: "code-review",
    status: "approved",
    summary: "The change is ready.",
    requirementCoverage: [],
    findings: [],
    missingTests: [],
    scopeViolations: [],
    recommendedAction: "proceed",
    metadata: {
      schemaVersion: 1,
      artifactId: "review-8",
      createdAt: "2026-07-30T00:00:00.000Z",
      durationMs: 1,
      producer: { kind: "codex", role: "reviewer", threadId: "review-thread" },
      sourceDigests: {},
      eventLog: [],
    },
  },
  artifactPath: "C:/runs/review.json",
  commentId: 18,
};

describe("runReviewCommand", () => {
  it("parses the Issue target, passes --run-id, and emits JSON", async () => {
    const chunks: string[] = [];
    let receivedRunId: string | undefined;
    const commandResult = await runReviewCommand(
      "owner/repo#8",
      { json: true, runId: result.runId, repoPath: "C:/repo" },
      {
        cwd: "C:/repo",
        stdout: (text) => chunks.push(text),
        review: {} as never,
        reviewIssue: async (input) => {
          receivedRunId = input.runId;
          return result;
        },
      },
    );

    expect(commandResult.exitCode).toBe(0);
    expect(receivedRunId).toBe(result.runId);
    expect(JSON.parse(chunks.join("")).review.status).toBe("approved");
  });
});
