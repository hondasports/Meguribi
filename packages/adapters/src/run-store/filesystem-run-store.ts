import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  RunCommand,
  RunIdentity,
  RunState,
  RunStore,
} from "@meguribi/core";
import { RunStateSchema } from "@meguribi/schemas";
import * as v from "valibot";

export interface FileSystemRunStoreOptions {
  rootDir: string;
  now?: () => Date;
  randomId?: () => string;
}

interface LockPayload {
  repository: string;
  issueNumber: number;
  runId: string;
  createdAt: string;
  updatedAt: string;
  pid: number;
}

/**
 * Local filesystem RunStore.
 * Layout: <root>/runs/<owner>/<repo>/issue-<n>/<runId>/state.json (+ artifacts)
 */
export class FileSystemRunStore implements RunStore {
  private readonly rootDir: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;

  constructor(options: FileSystemRunStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomBytes(3).toString("hex"));
  }

  async create(input: {
    repository: string;
    issueNumber: number;
    command: RunCommand;
    identity: RunIdentity;
    maxFixAttempts: number;
  }): Promise<RunState> {
    const runId = createRunId(this.now(), this.randomId());
    const createdAt = this.now().toISOString();
    const state: RunState = {
      schemaVersion: 1,
      runId,
      repository: input.repository,
      issueNumber: input.issueNumber,
      command: input.command,
      status: "created",
      completedSteps: [],
      branch: input.identity.branch,
      worktreePath: input.identity.worktreePath,
      baseRef: input.identity.baseRef,
      baseSha: input.identity.baseSha,
      headSha: input.identity.headSha,
      remoteIdentity: input.identity.remoteIdentity,
      pullRequestNumber: null,
      agentSessions: {},
      fixAttempts: 0,
      maxFixAttempts: input.maxFixAttempts,
      createdAt,
      updatedAt: createdAt,
    };

    const validated = v.parse(RunStateSchema, state);
    const runDir = this.runDir(validated.repository, validated.issueNumber, validated.runId);
    await fs.mkdir(runDir, { recursive: true });
    await this.writeState(runDir, validated);
    await this.writeRunIndex(validated.runId, validated.repository, validated.issueNumber);
    return validated;
  }

  async load(runId: string): Promise<RunState | null> {
    const located = await this.resolveRunDirById(runId);
    if (!located) {
      return null;
    }
    return this.readState(located);
  }

  async loadLatest(repository: string, issueNumber: number): Promise<RunState | null> {
    const issueDir = this.issueDir(repository, issueNumber);
    let entries: string[];
    try {
      entries = await fs.readdir(issueDir);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    const runIds = entries
      .filter((name) => !name.startsWith(".") && name !== "lock")
      .sort()
      .reverse();

    for (const candidate of runIds) {
      const state = await this.readState(path.join(issueDir, candidate));
      if (state) {
        return state;
      }
    }
    return null;
  }

  async update(runId: string, patch: Partial<RunState>): Promise<RunState> {
    const runDir = await this.resolveRunDirById(runId);
    if (!runDir) {
      throw new Error(`Run not found: ${runId}`);
    }
    const current = await this.readState(runDir);
    if (!current) {
      throw new Error(`Run state missing: ${runId}`);
    }
    const next = v.parse(RunStateSchema, {
      ...current,
      ...patch,
      schemaVersion: 1,
      runId: current.runId,
      repository: current.repository,
      issueNumber: current.issueNumber,
      updatedAt: patch.updatedAt ?? this.now().toISOString(),
    });
    await this.writeState(runDir, next);
    return next;
  }

  async saveArtifact(runId: string, name: string, value: unknown): Promise<string> {
    const runDir = await this.requireRunDir(runId);
    const safeName = sanitizeArtifactName(name);
    const artifactPath = path.join(runDir, safeName);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    const contents =
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    await atomicWriteFile(artifactPath, contents);
    return artifactPath;
  }

  async readArtifact<T>(runId: string, name: string): Promise<T | null> {
    const runDir = await this.resolveRunDirById(runId);
    if (!runDir) {
      return null;
    }
    const artifactPath = path.join(runDir, sanitizeArtifactName(name));
    try {
      const raw = await fs.readFile(artifactPath, "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async acquireLock(input: {
    repository: string;
    issueNumber: number;
    runId: string;
  }): Promise<void> {
    const lockPath = this.lockPath(input.repository, input.issueNumber);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const payload: LockPayload = {
      repository: input.repository,
      issueNumber: input.issueNumber,
      runId: input.runId,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      pid: process.pid,
    };

    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        let existing: LockPayload | undefined;
        try {
          existing = JSON.parse(await fs.readFile(lockPath, "utf8")) as LockPayload;
        } catch {
          existing = undefined;
        }
        throw new Error(
          existing
            ? `Run lock held by run ${existing.runId} (pid ${existing.pid}) for ${input.repository}#${String(input.issueNumber)}`
            : `Run lock already held for ${input.repository}#${String(input.issueNumber)}`,
        );
      }
      throw error;
    }
  }

  async releaseLock(input: {
    repository: string;
    issueNumber: number;
  }): Promise<void> {
    const lockPath = this.lockPath(input.repository, input.issueNumber);
    await fs.rm(lockPath, { force: true });
  }

  private runsRoot(): string {
    return path.join(this.rootDir, "runs");
  }

  private issueDir(repository: string, issueNumber: number): string {
    const { owner, repo } = splitRepository(repository);
    const issueDir = path.resolve(
      this.runsRoot(),
      owner,
      repo,
      `issue-${String(issueNumber)}`,
    );
    assertPathInside(this.runsRoot(), issueDir);
    return issueDir;
  }

  private runDir(repository: string, issueNumber: number, runId: string): string {
    const runDir = path.resolve(this.issueDir(repository, issueNumber), sanitizeRunId(runId));
    assertPathInside(this.runsRoot(), runDir);
    return runDir;
  }

  private lockPath(repository: string, issueNumber: number): string {
    return path.join(this.issueDir(repository, issueNumber), "lock");
  }

  private indexPath(runId: string): string {
    const indexPath = path.resolve(this.runsRoot(), "_by-id", `${sanitizeRunId(runId)}.json`);
    assertPathInside(this.runsRoot(), indexPath);
    return indexPath;
  }

  private async writeRunIndex(
    runId: string,
    repository: string,
    issueNumber: number,
  ): Promise<void> {
    const indexPath = this.indexPath(runId);
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await atomicWriteFile(
      indexPath,
      `${JSON.stringify({ repository, issueNumber, runId }, null, 2)}\n`,
    );
  }

  private async resolveRunDirById(runId: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.indexPath(runId), "utf8");
      const parsed = JSON.parse(raw) as {
        repository: string;
        issueNumber: number;
        runId: string;
      };
      return this.runDir(parsed.repository, parsed.issueNumber, parsed.runId);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }
    return null;
  }

  private async requireRunDir(runId: string): Promise<string> {
    const runDir = await this.resolveRunDirById(runId);
    if (!runDir) {
      throw new Error(`Run not found: ${runId}`);
    }
    return runDir;
  }

  private async writeState(runDir: string, state: RunState): Promise<void> {
    await atomicWriteFile(
      path.join(runDir, "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  private async readState(runDir: string): Promise<RunState | null> {
    try {
      const raw = await fs.readFile(path.join(runDir, "state.json"), "utf8");
      return v.parse(RunStateSchema, JSON.parse(raw));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
}

export function createRunId(now: Date, randomId: string): string {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${iso}-${randomId}`;
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const parts = repository.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid repository identity: ${repository}`);
  }
  const [owner, repo] = parts;
  assertSafePathSegment(owner, "owner");
  assertSafePathSegment(repo, "repo");
  return { owner: owner!, repo: repo! };
}

function assertSafePathSegment(value: string | undefined, label: string): void {
  if (!value || value === "." || value === ".." || value.includes("\\") || value.includes("\0")) {
    throw new Error(`Invalid repository ${label} segment: ${value ?? "(empty)"}`);
  }
}

function sanitizeRunId(runId: string): string {
  if (
    !runId ||
    runId.includes("\0") ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId.split(/[/\\]/).some((part) => part === ".." || part === ".")
  ) {
    throw new Error(`Invalid run id: ${runId}`);
  }
  return runId;
}

function assertPathInside(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes RunStore root: ${candidate}`);
  }
}

function sanitizeArtifactName(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  if (
    normalized.includes("\0") ||
    path.isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw new Error(`Invalid artifact name: ${name}`);
  }
  return normalized;
}

async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    try {
      await fs.rename(tempPath, filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // Windows cannot rename over an existing destination.
      if (err.code === "EEXIST" || err.code === "EPERM" || err.code === "EACCES") {
        await fs.rm(filePath, { force: true });
        await fs.rename(tempPath, filePath);
      } else {
        throw error;
      }
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
