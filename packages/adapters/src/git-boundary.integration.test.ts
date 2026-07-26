import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureGitWorktreeSnapshot, compareGitWorktreeSnapshots } from "./git-boundary.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-git-boundary-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "user.name", "Meguribi Test");
  await fs.writeFile(path.join(root, "README.md"), "# fixture\n", "utf8");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "fixture");
  return root;
}

describe("git worktree safety boundary", () => {
  it("treats Git diff as authoritative and allows an in-scope file", async () => {
    const root = await repo();
    const before = await captureGitWorktreeSnapshot({ cwd: root });
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "change.ts"), "export const ok = true;\n", "utf8");
    const after = await captureGitWorktreeSnapshot({ cwd: root });
    const result = await compareGitWorktreeSnapshots({ before, after, expectedBranch: "main", protectedPaths: [".env*"], maxChangedFiles: 5, maxDiffLines: 20 });
    expect(result).toMatchObject({ verdict: "allowed", publishable: true, changedFiles: ["src/change.ts"] });
  });

  it("blocks commits, protected paths, limits, and outside changes", async () => {
    const root = await repo();
    const before = await captureGitWorktreeSnapshot({ cwd: root });
    await fs.writeFile(path.join(root, ".env.local"), "TOKEN=fixture\n", "utf8");
    await fs.writeFile(path.join(root, "large.txt"), "x\n".repeat(20), "utf8");
    await git(root, "add", ".env.local", "large.txt");
    await git(root, "commit", "-m", "unexpected");
    const after = await captureGitWorktreeSnapshot({ cwd: root });
    const result = await compareGitWorktreeSnapshots({ before, after, protectedPaths: [".env*"], maxChangedFiles: 1, maxDiffLines: 1, outsidePaths: [path.join(path.dirname(root), "outside.txt")] });
    expect(result.publishable).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(["HEAD changed; Devin must not create commits", "protected path changed", "diff line limit exceeded", "filesystem change outside worktree"]));
  });
});
