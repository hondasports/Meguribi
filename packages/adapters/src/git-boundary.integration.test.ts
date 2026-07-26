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

  it("records and validates the approved base SHA", async () => {
    const root = await repo();
    const baseSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true })).stdout.trim();
    const before = await captureGitWorktreeSnapshot({ cwd: root, baseSha });
    await fs.writeFile(path.join(root, "src.txt"), "in scope\n", "utf8");
    const after = await captureGitWorktreeSnapshot({ cwd: root, baseSha });
    const result = await compareGitWorktreeSnapshots({
      before,
      after,
      expectedBaseSha: baseSha,
      maxChangedFiles: 5,
      maxDiffLines: 20,
    });
    expect(before.baseSha).toBe(baseSha);
    expect(result.publishable).toBe(true);
  });

  it("blocks commits, protected paths, limits, and outside changes", async () => {
    const root = await repo();
    const outsidePath = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
    roots.push(outsidePath);
    const before = await captureGitWorktreeSnapshot({ cwd: root, outsidePaths: [outsidePath] });
    await fs.writeFile(path.join(root, ".env.local"), "TOKEN=fixture\n", "utf8");
    await fs.writeFile(path.join(root, "large.txt"), "x\n".repeat(20), "utf8");
    await git(root, "add", ".env.local", "large.txt");
    await git(root, "commit", "-m", "unexpected");
    await fs.writeFile(outsidePath, "outside\n", "utf8");
    const after = await captureGitWorktreeSnapshot({ cwd: root, outsidePaths: [outsidePath] });
    const result = await compareGitWorktreeSnapshots({ before, after, protectedPaths: [".env*"], maxChangedFiles: 1, maxDiffLines: 1, outsidePaths: [outsidePath] });
    expect(result.publishable).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(["HEAD changed; Devin must not create commits", "protected path changed", "diff line limit exceeded", "filesystem change outside worktree"]));
  });

  it("counts untracked content toward the diff limit", async () => {
    const root = await repo();
    const before = await captureGitWorktreeSnapshot({ cwd: root });
    await fs.writeFile(path.join(root, "untracked-large.txt"), "x\n".repeat(20), "utf8");
    const after = await captureGitWorktreeSnapshot({ cwd: root });
    const result = await compareGitWorktreeSnapshots({
      before,
      after,
      expectedBranch: "main",
      maxChangedFiles: 5,
      maxDiffLines: 1,
    });
    expect(result.reasons).toContain("diff line limit exceeded");
  });

  it("blocks oversized tracked changes without reading their contents into memory", async () => {
    const root = await repo();
    const before = await captureGitWorktreeSnapshot({ cwd: root });
    await fs.writeFile(path.join(root, "README.md"), Buffer.alloc(16 * 1024 * 1024 + 1, 120));
    const after = await captureGitWorktreeSnapshot({ cwd: root });
    const result = await compareGitWorktreeSnapshots({
      before,
      after,
      maxChangedFiles: 5,
      maxDiffLines: Number.MAX_SAFE_INTEGER,
    });
    expect(result.reasons).toContain("file size exceeds snapshot safety limit");
  });

  it("warns when Devin's reported files do not match Git diff", async () => {
    const root = await repo();
    const before = await captureGitWorktreeSnapshot({ cwd: root });
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "change.ts"), "export const ok = true;\n", "utf8");
    const after = await captureGitWorktreeSnapshot({ cwd: root });
    const result = await compareGitWorktreeSnapshots({
      before,
      after,
      reportedFiles: ["wrong.ts"],
      maxChangedFiles: 5,
      maxDiffLines: 20,
    });
    expect(result.publishable).toBe(true);
    expect(result.warnings).toContain("Devin reported files differ from Git diff");
  });

  it("detects additional edits to a pre-existing dirty protected file", async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, ".env.local"), "TOKEN=before\n", "utf8");
    const before = await captureGitWorktreeSnapshot({ cwd: root });
    await fs.writeFile(path.join(root, ".env.local"), "TOKEN=after\n", "utf8");
    const after = await captureGitWorktreeSnapshot({ cwd: root });
    const result = await compareGitWorktreeSnapshots({
      before,
      after,
      protectedPaths: [".env*"],
      maxChangedFiles: 5,
      maxDiffLines: 20,
    });
    expect(result.reasons).toContain("protected path changed");
  });

  it("detects a remote URL change even though raw remote data is not exposed", async () => {
    const root = await repo();
    await git(root, "remote", "add", "origin", "https://example.invalid/owner/one.git");
    const before = await captureGitWorktreeSnapshot({ cwd: root });
    await git(root, "remote", "set-url", "origin", "https://example.invalid/owner/two.git");
    const after = await captureGitWorktreeSnapshot({ cwd: root });
    const result = await compareGitWorktreeSnapshots({
      before,
      after,
      maxChangedFiles: 5,
      maxDiffLines: 20,
    });
    expect(result.reasons).toContain("Git remote configuration changed");
  });

  it("blocks changes to pre-existing dirty state and hidden commit/reset history", async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, "README.md"), "pre-existing\n", "utf8");
    const before = await captureGitWorktreeSnapshot({ cwd: root });
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "unexpected");
    await git(root, "reset", "--hard", before.head);
    await fs.writeFile(path.join(root, "README.md"), "changed\n", "utf8");
    const after = await captureGitWorktreeSnapshot({ cwd: root });
    const result = await compareGitWorktreeSnapshots({ before, after, maxChangedFiles: 5, maxDiffLines: 20 });
    expect(result.reasons).toEqual(expect.arrayContaining(["Git reflog changed", "pre-existing dirty state changed"]));
  });
});
