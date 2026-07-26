import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ProcessRunner } from "@meguribi/process";
import { redactDiagnosticText } from "./devin/redact.js";

export interface GitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface GitCommandRunner {
  run(args: readonly string[], cwd: string): Promise<GitCommandResult>;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export class ProcessGitCommandRunner implements GitCommandRunner {
  async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    const processHandle = new ProcessRunner().run("git", [...args], { cwd, env: process.env });
    const [stdout, stderr, exit] = await Promise.all([
      collect(processHandle.stdout),
      collect(processHandle.stderr),
      processHandle.waitForExit(),
    ]);
    return { exitCode: exit.code, stdout, stderr };
  }
}

export interface GitWorktreeSnapshot {
  root: string;
  commonDir: string;
  branch: string;
  head: string;
  dirty: boolean;
  statusEntries: Readonly<Record<string, string>>;
  changedFiles: readonly string[];
  diffLines: number;
  hasBinary: boolean;
  lastCommitFiles: readonly string[];
  lastCommitDiffLines: number;
  lastCommitHasBinary: boolean;
  remoteDigest: string;
  configDigest: string;
}

export interface GitWorktreeSnapshotInput {
  cwd: string;
  runner?: GitCommandRunner;
}

async function gitValue(runner: GitCommandRunner, cwd: string, args: readonly string[]): Promise<string> {
  const result = await runner.run(args, cwd);
  if (result.exitCode !== 0 || result.exitCode === null) {
    throw new Error(`Git command failed: git ${args.join(" ")} (${result.stderr.trim() || "unknown error"})`);
  }
  return result.stdout.trim();
}

function parseStatus(output: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const record of output.split("\0")) {
    if (!record) continue;
    const status = record.slice(0, 2);
    const file = record.slice(3);
    if (file && !file.endsWith("/")) entries[file] = status;
  }
  return entries;
}

function parseNullPaths(output: string): string[] {
  return output.split("\0").map((file) => file.trim()).filter(Boolean);
}

function parseNumstat(output: string): { diffLines: number; hasBinary: boolean } {
  let diffLines = 0;
  let hasBinary = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [added, deleted] = line.split("\t");
    if (added === "-" || deleted === "-") {
      hasBinary = true;
      continue;
    }
    const additions = Number(added);
    const deletions = Number(deleted);
    if (Number.isSafeInteger(additions) && Number.isSafeInteger(deletions)) diffLines += additions + deletions;
  }
  return { diffLines, hasBinary };
}

function digest(value: string): string {
  return createHash("sha256").update(redactDiagnosticText(value), "utf8").digest("hex");
}

export async function captureGitWorktreeSnapshot(input: GitWorktreeSnapshotInput): Promise<GitWorktreeSnapshot> {
  const runner = input.runner ?? new ProcessGitCommandRunner();
  const cwd = path.resolve(input.cwd);
  const root = path.resolve(await gitValue(runner, cwd, ["rev-parse", "--show-toplevel"]));
  const commonDirRaw = await gitValue(runner, cwd, ["rev-parse", "--git-common-dir"]);
  const commonDir = path.resolve(root, commonDirRaw);
  const branch = await gitValue(runner, cwd, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "(detached)");
  const head = await gitValue(runner, cwd, ["rev-parse", "HEAD"]);
  const status = parseStatus(await gitValue(runner, cwd, ["status", "--porcelain=v1", "-z"]));
  for (const file of parseNullPaths(await gitValue(runner, cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    status[file] = "??";
  }
  const numstat = parseNumstat(await gitValue(runner, cwd, ["diff", "HEAD", "--numstat"]));
  const lastCommitNumstat = parseNumstat(await gitValue(runner, cwd, ["show", "--format=", "--numstat", "HEAD"]));
  const lastCommitFiles = (await gitValue(runner, cwd, ["show", "--format=", "--name-only", "HEAD"]))
    .split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
  const remote = await gitValue(runner, cwd, ["remote", "-v"]);
  const config = await gitValue(runner, cwd, ["config", "--local", "--list"]);
  return {
    root,
    commonDir,
    branch,
    head,
    dirty: Object.keys(status).length > 0,
    statusEntries: status,
    changedFiles: Object.keys(status).sort(),
    diffLines: numstat.diffLines,
    hasBinary: numstat.hasBinary,
    lastCommitFiles,
    lastCommitDiffLines: lastCommitNumstat.diffLines,
    lastCommitHasBinary: lastCommitNumstat.hasBinary,
    remoteDigest: digest(remote),
    configDigest: digest(config),
  };
}

function pathMatches(relativePath: string, patterns: readonly string[]): boolean {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  return patterns.some((pattern) => {
    const normalized = pattern.replaceAll("\\", "/");
    if (normalized.endsWith("/**")) return normalizedPath === normalized.slice(0, -3) || normalizedPath.startsWith(`${normalized.slice(0, -3)}/`);
    if (normalized.endsWith("*")) return normalizedPath.startsWith(normalized.slice(0, -1));
    return normalizedPath === normalized;
  });
}

export interface GitSafetyComparisonInput {
  before: GitWorktreeSnapshot;
  after: GitWorktreeSnapshot;
  expectedBranch?: string;
  protectedPaths?: readonly string[];
  maxChangedFiles: number;
  maxDiffLines: number;
  outsidePaths?: readonly string[];
}

export interface GitSafetyComparison {
  verdict: "allowed" | "blocked" | "suspicious";
  publishable: boolean;
  reasons: readonly string[];
  changedFiles: readonly string[];
  preExistingDirty: boolean;
}

export async function compareGitWorktreeSnapshots(input: GitSafetyComparisonInput): Promise<GitSafetyComparison> {
  const { before, after } = input;
  const reasons: string[] = [];
  const statusChangedFiles = Object.keys(after.statusEntries).filter((file) => before.statusEntries[file] !== after.statusEntries[file]);
  const committedFiles = before.head !== after.head ? after.lastCommitFiles : [];
  const changedFiles = [...new Set([...statusChangedFiles, ...committedFiles])].sort();
  const effectiveDiffLines = before.head !== after.head ? after.lastCommitDiffLines : after.diffLines;
  const effectiveBinary = before.head !== after.head ? after.lastCommitHasBinary : after.hasBinary;
  if (before.root !== after.root || before.commonDir !== after.commonDir) reasons.push("repository identity changed");
  if (before.head !== after.head) reasons.push("HEAD changed; Devin must not create commits");
  if (before.branch !== after.branch || (input.expectedBranch && after.branch !== input.expectedBranch)) reasons.push("branch changed");
  if (before.remoteDigest !== after.remoteDigest) reasons.push("Git remote configuration changed");
  if (before.configDigest !== after.configDigest) reasons.push("local Git configuration changed");
  if (changedFiles.some((file) => pathMatches(file, input.protectedPaths ?? []))) reasons.push("protected path changed");
  if (changedFiles.length > input.maxChangedFiles) reasons.push("changed file limit exceeded");
  if (effectiveDiffLines > input.maxDiffLines) reasons.push("diff line limit exceeded");
  if (effectiveBinary) reasons.push("binary file changed");

  const root = path.resolve(after.root);
  for (const outsidePath of input.outsidePaths ?? []) {
    const absolute = path.resolve(outsidePath);
    const relative = path.relative(root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) reasons.push("filesystem change outside worktree");
  }
  for (const file of changedFiles) {
    const absolute = path.resolve(root, file);
    try {
      const real = await fs.realpath(absolute);
      const relative = path.relative(root, real);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) reasons.push("symlink escapes worktree");
    } catch {
      // A newly created, non-existent path is still checked by path.resolve above.
    }
  }
  const uniqueReasons = [...new Set(reasons)];
  const blocked = uniqueReasons.length > 0;
  return {
    verdict: blocked ? "blocked" : "allowed",
    publishable: !blocked,
    reasons: uniqueReasons,
    changedFiles,
    preExistingDirty: before.dirty,
  };
}
