import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGitAdapter } from "./command.js";
import type { GitCommandRunner } from "../git-boundary.js";

class QueueRunner implements GitCommandRunner {
  readonly calls: Array<{ args: readonly string[]; cwd: string }> = [];

  constructor(private readonly responses: Array<{ exitCode: number | null; stdout: string; stderr: string }>) {}

  async run(args: readonly string[], cwd: string) {
    this.calls.push({ args, cwd });
    const response = this.responses.shift();
    if (!response) throw new Error("response queue exhausted");
    return response;
  }
}

describe("Git command adapter", () => {
  it("creates an Issue worktree only on a non-protected branch and verifies the remote", async () => {
    const runner = new QueueRunner([
      { exitCode: 0, stdout: "C:/repo\n", stderr: "" },
      { exitCode: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" },
      { exitCode: 0, stdout: "base-sha\n", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "head-sha\n", stderr: "" },
      { exitCode: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" },
    ]);
    const adapter = createGitAdapter({ expectedRepository: "owner/repo", runner });

    await expect(
      adapter.ensureWorktree({
        repositoryPath: "C:/repo",
        worktreePath: "C:/worktree",
        branch: "meguribi/issue-22",
        baseRef: "origin/main",
      }),
    ).resolves.toEqual({
      baseSha: "base-sha",
      headSha: "head-sha",
      remoteIdentity: "github.com/owner/repo",
    });
    expect(runner.calls.some(({ args }) => args[0] === "worktree" && args[1] === "add")).toBe(true);
  });

  it("rejects protected branches before running Git commands", async () => {
    const runner = new QueueRunner([]);
    const adapter = createGitAdapter({ runner });

    await expect(
      adapter.ensureWorktree({
        repositoryPath: "C:/repo",
        worktreePath: "C:/worktree",
        branch: "main",
        baseRef: "origin/main",
      }),
    ).rejects.toThrow(/protected branch/);
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a remote that only has a matching suffix", async () => {
    const runner = new QueueRunner([
      { exitCode: 0, stdout: "C:/repo\n", stderr: "" },
      { exitCode: 0, stdout: "https://github.com/other/owner/repo.git\n", stderr: "" },
    ]);
    const adapter = createGitAdapter({ expectedRepository: "owner/repo", runner });

    await expect(
      adapter.ensureWorktree({
        repositoryPath: "C:/repo",
        worktreePath: "C:/worktree",
        branch: "meguribi/issue-22",
        baseRef: "origin/main",
      }),
    ).rejects.toThrow(/does not match target repository/);
  });

  it("expands untracked directories before reading their files for a diff", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-git-diff-"));
    try {
      await fs.mkdir(path.join(root, "public"));
      await fs.writeFile(path.join(root, "public", "index.html"), "<main />\n", "utf8");
      const runner = new QueueRunner([
        { exitCode: 0, stdout: "?? public/index.html\0", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
      ]);
      const adapter = createGitAdapter({ runner });

      await expect(adapter.getDiff(root)).resolves.toEqual({
        changedFiles: ["public/index.html"],
        patch: expect.stringContaining("public/index.html"),
      });
      expect(runner.calls[0]?.args).toEqual(["status", "--porcelain=v1", "-z", "-uall"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
