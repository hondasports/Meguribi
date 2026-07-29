import fs from "node:fs/promises";
import path from "node:path";
import type { GitAdapter } from "@meguribi/core";
import { redactDiagnosticText } from "../devin/redact.js";
import { ProcessGitCommandRunner, type GitCommandRunner } from "../git-boundary.js";

export interface GitAdapterOptions {
  expectedRepository?: string;
  allowMissingRemote?: boolean;
  runner?: GitCommandRunner;
}

async function gitValue(
  runner: GitCommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await runner.run(args, cwd);
  if (result.exitCode !== 0 || result.exitCode === null) {
    const detail = redactDiagnosticText(result.stderr.trim()).slice(0, 500);
    throw new Error(`Git command failed: git ${args.join(" ")}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function normalizeRepository(remote: string): string {
  const value = remote.trim().replace(/\.git$/, "");
  if (value.startsWith("git@")) {
    const separator = value.indexOf(":");
    if (separator > 0) return `${value.slice(4, separator).toLowerCase()}/${value.slice(separator + 1)}`;
  }
  try {
    const url = new URL(value);
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\//, "")}`;
  } catch {
    throw new Error("Git origin URL is not a supported HTTPS or SSH repository URL");
  }
}

function repositoryIdentity(remote: string): string {
  return normalizeRepository(remote);
}

function assertWorktreeBranch(branch: string): void {
  if (!branch || branch === "main" || branch === "master" || branch === "develop") {
    throw new Error(`Refusing to use protected branch '${branch || "(empty)"}'; provide an Issue-specific worktree branch`);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseStatus(output: string): string[] {
  const files: string[] = [];
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const file = record.slice(3);
    if (file && !file.endsWith("/")) files.push(file);
    if (status.includes("R") && records[index + 1]) {
      files.push(records[index + 1]);
      index += 1;
    }
  }
  return files;
}

function untrackedPatch(file: string, contents: string): string {
  const lines = contents.split(/\r?\n/);
  const body = lines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    body,
  ].join("\n");
}

export function createGitAdapter(options: GitAdapterOptions = {}): GitAdapter {
  const runner = options.runner ?? new ProcessGitCommandRunner();

  async function remoteIdentity(repositoryPath: string): Promise<string> {
    let remote: string;
    try {
      remote = await gitValue(runner, repositoryPath, ["remote", "get-url", "origin"]);
    } catch (error) {
      if (options.allowMissingRemote) {
        const root = await gitValue(runner, repositoryPath, ["rev-parse", "--show-toplevel"]);
        return `local:${path.resolve(root)}`;
      }
      throw error;
    }
    const identity = repositoryIdentity(remote);
    const expectedIdentity = options.expectedRepository
      ? `github.com/${options.expectedRepository.replace(/^\/+/, "").replace(/\.git$/, "")}`.toLowerCase()
      : undefined;
    if (expectedIdentity !== undefined && identity.toLowerCase() !== expectedIdentity) {
      throw new Error(`Git remote '${identity}' does not match target repository '${options.expectedRepository}'; stop and choose the matching checkout`);
    }
    return identity;
  }

  return {
    async ensureWorktree(input) {
      assertWorktreeBranch(input.branch);
      const root = await gitValue(runner, input.repositoryPath, ["rev-parse", "--show-toplevel"]);
      await remoteIdentity(root);
      if (path.resolve(root) !== path.resolve(input.repositoryPath)) {
        throw new Error(`Repository path must be the checkout root: ${input.repositoryPath}`);
      }
      if (await exists(input.worktreePath)) {
        throw new Error(`Worktree path already exists: ${input.worktreePath}; resume the existing run or choose a new Issue worktree`);
      }
      const baseSha = await gitValue(runner, root, ["rev-parse", input.baseRef]);
      const branchCheck = await runner.run(["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`], root);
      if (branchCheck.exitCode === 0) {
        throw new Error(`Git branch already exists: ${input.branch}; resume the existing run instead of overwriting it`);
      }
      if (branchCheck.exitCode !== 1) {
        throw new Error(`Unable to inspect whether Git branch exists: ${input.branch}`);
      }
      const add = await runner.run(["worktree", "add", "-b", input.branch, input.worktreePath, input.baseRef], root);
      if (add.exitCode !== 0 || add.exitCode === null) {
        throw new Error(`Git worktree creation failed for ${input.worktreePath}: ${add.stderr.trim().slice(0, 500)}`);
      }
      const headSha = await gitValue(runner, input.worktreePath, ["rev-parse", "HEAD"]);
      return { baseSha, headSha, remoteIdentity: await remoteIdentity(input.worktreePath) };
    },

    async getIdentity(worktreePath) {
      const branch = await gitValue(runner, worktreePath, ["symbolic-ref", "--short", "-q", "HEAD"]);
      assertWorktreeBranch(branch);
      return {
        branch,
        headSha: await gitValue(runner, worktreePath, ["rev-parse", "HEAD"]),
        remoteIdentity: await remoteIdentity(worktreePath),
      };
    },

    async getDiff(worktreePath) {
      const status = await gitValue(runner, worktreePath, ["status", "--porcelain=v1", "-z", "-uall"]);
      const changedFiles = parseStatus(status);
      const trackedPatch = await gitValue(runner, worktreePath, ["diff", "HEAD", "--no-ext-diff", "--binary"]);
      const untracked = changedFiles.filter((file) => status.includes(`?? ${file}`));
      const patches = [trackedPatch];
      for (const file of untracked) {
        const contents = await fs.readFile(path.join(worktreePath, file), "utf8");
        patches.push(untrackedPatch(file.replaceAll("\\", "/"), contents));
      }
      return { changedFiles: [...new Set(changedFiles)].sort(), patch: patches.filter(Boolean).join("\n") };
    },

    async commit(input) {
      const identity = await this.getIdentity(input.worktreePath);
      assertWorktreeBranch(identity.branch);
      const pathsToStage = [...new Set(input.paths)].filter(Boolean);
      if (pathsToStage.length === 0) throw new Error("Refusing to create an empty commit; no changed files were verified");
      const add = await runner.run(["add", "--", ...pathsToStage], input.worktreePath);
      if (add.exitCode !== 0 || add.exitCode === null) throw new Error(`Git stage failed: ${add.stderr.trim().slice(0, 500)}`);
      const staged = await runner.run(["diff", "--cached", "--quiet"], input.worktreePath);
      if (staged.exitCode === 0) throw new Error("Refusing to create an empty commit after staging");
      if (staged.exitCode !== 1) throw new Error(`Unable to inspect staged Git diff: ${staged.stderr.trim().slice(0, 500)}`);
      const commit = await runner.run(["commit", "-m", input.message], input.worktreePath);
      if (commit.exitCode !== 0 || commit.exitCode === null) throw new Error(`Git commit failed: ${commit.stderr.trim().slice(0, 500)}`);
      return { headSha: await gitValue(runner, input.worktreePath, ["rev-parse", "HEAD"]) };
    },

    async push(input) {
      const identity = await this.getIdentity(input.worktreePath);
      if (identity.branch !== input.branch) throw new Error(`Git branch changed before push: expected ${input.branch}, found ${identity.branch}`);
      await gitValue(runner, input.worktreePath, ["push", "origin", input.branch]);
    },
  };
}
