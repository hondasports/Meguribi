import { describe, expect, it } from "vitest";
import { runCleanupCommand } from "./cleanup.js";

describe("runCleanupCommand", () => {
  it("passes cleanup flags and emits JSON", async () => {
    let received: unknown;
    const output: string[] = [];
    const result = await runCleanupCommand("owner/repo#22", { json: true, dryRun: true, deleteBranch: true, runId: "run-22" }, {
      cleanupRun: async (input) => {
        received = input;
        return {
          schemaVersion: 1,
          artifactType: "cleanup",
          status: "dry_run",
          runId: "run-22",
          repository: "owner/repo",
          issueNumber: 22,
          worktreePath: "C:/worktree",
          branch: "meguribi/issue-22",
          pullRequestNumber: 101,
          pullRequestState: "closed",
          merged: true,
          worktreeRemoved: false,
          branchRemoved: false,
          artifactPath: "C:/runs/cleanup.json",
        };
      },
      cleanup: {} as never,
      stdout: (text) => output.push(text),
    });

    expect(result.exitCode).toBe(0);
    expect(received).toMatchObject({ repository: "owner/repo", issueNumber: 22, runId: "run-22", dryRun: true, deleteBranch: true });
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({ status: "dry_run" });
  });
});
