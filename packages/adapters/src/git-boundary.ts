import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ProcessRunner } from "@meguribi/process";

export interface GitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;

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
  baseSha: string;
  dirty: boolean;
  statusEntries: Readonly<Record<string, string>>;
  fileDigests: Readonly<Record<string, string>>;
  outsideDigests: Readonly<Record<string, string>>;
  changedFiles: readonly string[];
  diffLines: number;
  hasBinary: boolean;
  oversized: boolean;
  lastCommitFiles: readonly string[];
  lastCommitDiffLines: number;
  lastCommitHasBinary: boolean;
  remoteDigest: string;
  remoteIdentity: string;
  configDigest: string;
  reflogDigest: string;
}

export interface GitWorktreeSnapshotInput {
  cwd: string;
  runner?: GitCommandRunner;
  outsidePaths?: readonly string[];
  baseSha?: string;
}

async function gitValue(
  runner: GitCommandRunner,
  cwd: string,
  args: readonly string[],
  options?: { preserveWhitespace?: boolean },
): Promise<string> {
  const result = await runner.run(args, cwd);
  if (result.exitCode !== 0 || result.exitCode === null) {
    throw new Error(`Git command failed: git ${args.join(" ")} (${result.stderr.trim() || "unknown error"})`);
  }
  return options?.preserveWhitespace ? result.stdout : result.stdout.trim();
}

async function gitBranch(runner: GitCommandRunner, cwd: string): Promise<string> {
  const result = await runner.run(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
  if (result.exitCode === 0) return result.stdout.trim() || "(detached)";
  if (result.exitCode === 1) return "(detached)";
  throw new Error(`Git branch inspection failed (${result.stderr.trim() || "unknown error"})`);
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
  // Only the digest leaves this boundary; raw remote/config output is never
  // persisted. Redacting before hashing would make distinct URLs collide.
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function fileDigest(root: string, relativePath: string): Promise<string> {
  return digestPath(path.resolve(root, relativePath));
}

async function digestPath(absolute: string): Promise<string> {
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      return `symlink:${await fs.readlink(absolute)}`;
    }
    if (!stat.isFile()) {
      return `non-file:${stat.mode}`;
    }
    if (stat.size > MAX_SNAPSHOT_FILE_BYTES) {
      return `too-large:${stat.size}`;
    }
    const contents = await fs.readFile(absolute);
    return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    throw error;
  }
}

function safeRemoteIdentity(value: string): string {
  return value.split(/\r?\n/).map((line) => {
    const match = /^(\S+)\s+(\S+)/.exec(line.trim());
    if (!match) return "";
    const [, name, rawUrl] = match;
    try {
      const parsed = new URL(rawUrl);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return `${name} ${parsed.toString()}`;
    } catch {
      return `${name} ${rawUrl.replace(/^.*@/, "")}`;
    }
  }).filter(Boolean).join("\n");
}

async function untrackedStats(root: string, files: readonly string[]): Promise<{ diffLines: number; hasBinary: boolean; oversized: boolean }> {
  let diffLines = 0;
  let hasBinary = false;
  let oversized = false;
  for (const file of files) {
    const absolute = path.resolve(root, file);
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        hasBinary = true;
        continue;
      }
      if (stat.size > MAX_SNAPSHOT_FILE_BYTES) {
        oversized = true;
        continue;
      }
      const contents = await fs.readFile(absolute);
      if (contents.includes(0)) {
        hasBinary = true;
        continue;
      }
      const text = contents.toString("utf8");
      diffLines += text.length === 0 ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }
  return { diffLines, hasBinary, oversized };
}

export async function captureGitWorktreeSnapshot(input: GitWorktreeSnapshotInput): Promise<GitWorktreeSnapshot> {
  const runner = input.runner ?? new ProcessGitCommandRunner();
  const cwd = path.resolve(input.cwd);
  const root = path.resolve(await gitValue(runner, cwd, ["rev-parse", "--show-toplevel"]));
  const commonDirRaw = await gitValue(runner, cwd, ["rev-parse", "--git-common-dir"]);
  const commonDir = path.resolve(root, commonDirRaw);
  const branch = await gitBranch(runner, cwd);
  const head = await gitValue(runner, cwd, ["rev-parse", "HEAD"]);
  const baseSha = input.baseSha
    ? await gitValue(runner, cwd, ["merge-base", head, input.baseSha])
    : head;
  const status = parseStatus(await gitValue(
    runner,
    cwd,
    ["status", "--porcelain=v1", "-z"],
    { preserveWhitespace: true },
  ));
  for (const file of parseNullPaths(await gitValue(runner, cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    status[file] = "??";
  }
  const statusFiles = Object.keys(status);
  const fileDigests: Record<string, string> = {};
  let oversized = false;
  for (const file of statusFiles) {
    const fileHash = await fileDigest(root, file);
    fileDigests[file] = fileHash;
    oversized ||= fileHash.startsWith("too-large:");
  }
  const untracked = await untrackedStats(root, statusFiles.filter((file) => status[file] === "??"));
  const numstat = parseNumstat(await gitValue(runner, cwd, ["diff", "HEAD", "--numstat"]));
  const lastCommitNumstat = parseNumstat(await gitValue(runner, cwd, ["show", "--format=", "--numstat", "HEAD"]));
  const lastCommitFiles = (await gitValue(runner, cwd, ["show", "--format=", "--name-only", "HEAD"]))
    .split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
  const remote = await gitValue(runner, cwd, ["remote", "-v"]);
  const config = await gitValue(runner, cwd, ["config", "--local", "--list"]);
  const reflog = await gitValue(runner, cwd, ["reflog", "--all", "--format=%H %gs"]);
  const outsideDigests: Record<string, string> = {};
  for (const outsidePath of input.outsidePaths ?? []) {
    const absolute = path.resolve(outsidePath);
    outsideDigests[absolute] = await digestPath(absolute);
  }
  return {
    root,
    commonDir,
    branch,
    head,
    baseSha,
    dirty: Object.keys(status).length > 0,
    statusEntries: status,
    fileDigests,
    outsideDigests,
    changedFiles: statusFiles.sort(),
    diffLines: numstat.diffLines + untracked.diffLines,
    hasBinary: numstat.hasBinary || untracked.hasBinary,
    oversized: oversized || untracked.oversized,
    lastCommitFiles,
    lastCommitDiffLines: lastCommitNumstat.diffLines,
    lastCommitHasBinary: lastCommitNumstat.hasBinary,
    remoteDigest: digest(remote),
    remoteIdentity: remote.trim() ? safeRemoteIdentity(remote) : `local:${root}`,
    configDigest: digest(config),
    reflogDigest: digest(reflog),
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
  expectedBaseSha?: string;
  expectedRemoteIdentity?: string;
  protectedPaths?: readonly string[];
  maxChangedFiles: number;
  maxDiffLines: number;
  outsidePaths?: readonly string[];
  reportedFiles?: readonly string[];
}

export interface GitSafetyComparison {
  verdict: "allowed" | "blocked" | "suspicious";
  publishable: boolean;
  reasons: readonly string[];
  warnings: readonly string[];
  changedFiles: readonly string[];
  preExistingDirty: boolean;
}

export async function compareGitWorktreeSnapshots(input: GitSafetyComparisonInput): Promise<GitSafetyComparison> {
  const { before, after } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const candidateFiles = new Set([
    ...Object.keys(before.statusEntries),
    ...Object.keys(after.statusEntries),
    ...Object.keys(before.fileDigests),
    ...Object.keys(after.fileDigests),
  ]);
  const statusChangedFiles = [...candidateFiles].filter((file) =>
    before.statusEntries[file] !== after.statusEntries[file] ||
    before.fileDigests[file] !== after.fileDigests[file],
  );
  const committedFiles = before.head !== after.head ? after.lastCommitFiles : [];
  const changedFiles = [...new Set([...statusChangedFiles, ...committedFiles])].sort();
  if (input.reportedFiles) {
    const normalizeFiles = (files: readonly string[]) => [...new Set(files.map((file) => file.replaceAll("\\", "/")))].sort();
    if (JSON.stringify(normalizeFiles(input.reportedFiles)) !== JSON.stringify(normalizeFiles(changedFiles))) {
      warnings.push("Devin reported files differ from Git diff");
    }
  }
  const effectiveDiffLines = before.head !== after.head ? after.lastCommitDiffLines : after.diffLines;
  const effectiveBinary = before.head !== after.head ? after.lastCommitHasBinary : after.hasBinary;
  if (before.root !== after.root || before.commonDir !== after.commonDir) reasons.push("repository identity changed");
  if (before.head !== after.head) reasons.push("HEAD changed; Devin must not create commits");
  if (before.baseSha !== after.baseSha) reasons.push("base SHA changed");
  if (input.expectedBaseSha && after.baseSha !== input.expectedBaseSha) reasons.push("base SHA does not match the approved base");
  if (before.branch !== after.branch || (input.expectedBranch && after.branch !== input.expectedBranch)) reasons.push("branch changed");
  if (before.remoteDigest !== after.remoteDigest) reasons.push("Git remote configuration changed");
  const expectedLocalRepository = input.expectedRemoteIdentity === "" && after.remoteIdentity.startsWith("local:");
  if (
    input.expectedRemoteIdentity !== undefined &&
    !expectedLocalRepository &&
    after.remoteIdentity !== input.expectedRemoteIdentity
  ) {
    reasons.push("repository remote identity does not match the approved repository");
  }
  if (before.configDigest !== after.configDigest) reasons.push("local Git configuration changed");
  if (before.reflogDigest !== after.reflogDigest) reasons.push("Git reflog changed");
  if (before.dirty && Object.keys(before.statusEntries).some((file) =>
    before.statusEntries[file] !== after.statusEntries[file] ||
    before.fileDigests[file] !== after.fileDigests[file],
  )) {
    reasons.push("pre-existing dirty state changed");
  }
  if (changedFiles.some((file) => pathMatches(file, input.protectedPaths ?? []))) reasons.push("protected path changed");
  if (changedFiles.length > input.maxChangedFiles) reasons.push("changed file limit exceeded");
  if (effectiveDiffLines > input.maxDiffLines) reasons.push("diff line limit exceeded");
  if (effectiveBinary) reasons.push("binary file changed");
  if (after.oversized) reasons.push("file size exceeds snapshot safety limit");

  const root = path.resolve(after.root);
  const outsidePaths = new Set([
    ...Object.keys(before.outsideDigests),
    ...Object.keys(after.outsideDigests),
    ...(input.outsidePaths ?? []).map((outsidePath) => path.resolve(outsidePath)),
  ]);
  for (const outsidePath of outsidePaths) {
    const absolute = path.resolve(outsidePath);
    const relative = path.relative(root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      if (before.outsideDigests[absolute] !== after.outsideDigests[absolute]) {
        reasons.push("filesystem change outside worktree");
      }
    }
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
    warnings: [...new Set(warnings)],
    changedFiles,
    preExistingDirty: before.dirty,
  };
}
