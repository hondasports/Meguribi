import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import type { DevinDiagnosis, InheritedMcpPolicy, RunDeliveryInput } from "@meguribi/core";
import { runDelivery } from "@meguribi/core";
import { ProcessRunner } from "@meguribi/process";
import { createDevinAcpAdapter } from "../devin/acp-adapter.js";
import { createFakeDeliveryDeps } from "../fakes/delivery-fakes.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function node(): string {
  return process.execPath;
}

function fakeDevin(): string {
  return fileURLToPath(new URL("../devin/fixtures/fake-devin.js", import.meta.url));
}

function runnableDiagnosis(): DevinDiagnosis {
  return {
    executable: { status: "ok", path: node() },
    version: { status: "supported", raw: "3000.2.17" },
    authentication: { status: "authenticated" },
    acp: { status: "supported" },
    inheritedMcpPolicy: "allow",
    runnable: true,
    warnings: [],
    errors: [],
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function tempGitRepository(): Promise<{ cwd: string; artifactRoot: string; head: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-delivery-process-cwd-"));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-delivery-process-art-"));
  tempDirs.push(cwd, artifactRoot);

  await fs.writeFile(path.join(cwd, "README.md"), "# fixture\n", "utf8");
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "user.name", "Meguribi Test");
  await git(cwd, "remote", "add", "origin", "https://github.com/owner/repo.git");
  await git(cwd, "add", "README.md");
  await git(cwd, "commit", "-m", "fixture");
  const head = await git(cwd, "rev-parse", "HEAD");
  return { cwd, artifactRoot, head };
}

function input(
  pair: { cwd: string; artifactRoot: string },
  overrides: Partial<RunDeliveryInput> = {},
): RunDeliveryInput {
  return {
    repository: "owner/repo",
    issueNumber: 23,
    repositoryPath: pair.cwd,
    worktreePath: pair.cwd,
    branch: "main",
    baseRef: "main",
    repositoryRules: "Do not commit or push.",
    completionCriteria: ["the fixture completes"],
    outOfScope: ["real external services"],
    requiredLabels: ["agent:ready"],
    protectedPaths: [".env*"],
    verifyCommands: [{ name: "test", run: "fixture test" }],
    inheritedMcpPolicy: "allow",
    allowInheritedMcp: false,
    nonInteractive: true,
    maxFixAttempts: 1,
    artifactRootForDevin: pair.artifactRoot,
    noCommit: true,
    noPush: true,
    noPr: false,
    ...overrides,
  };
}

interface ProcessBoundaryOptions {
  inheritedMcpPolicy?: InheritedMcpPolicy;
  promptTimeoutMs?: number;
  stateFile?: string;
  outsidePath?: string;
}

async function processBoundaryBundle(
  pair: { cwd: string; artifactRoot: string; head: string },
  scenario: string,
  options: ProcessBoundaryOptions = {},
) {
  const bundle = createFakeDeliveryDeps({
    github: { issue: { number: 23 } },
    git: {
      identity: {
        branch: "main",
        headSha: pair.head,
        baseSha: pair.head,
        remoteIdentity: "origin https://github.com/owner/repo.git\norigin https://github.com/owner/repo.git",
      },
      diff: {
        changedFiles: ["README.md"],
        patch: "diff --git a/README.md b/README.md\n",
      },
    },
  });
  const env = {
    ...process.env,
    MEGURIBI_FAKE_DEVIN_SCENARIO: scenario,
    ...(options.stateFile ? { MEGURIBI_FAKE_DEVIN_STATE_FILE: options.stateFile } : {}),
    ...(options.outsidePath ? { MEGURIBI_FAKE_OUTSIDE_PATH: options.outsidePath } : {}),
  };
  const devin = createDevinAcpAdapter({
    executable: node(),
    executableArgs: [fakeDevin()],
    acpArgs: ["acp"],
    diagnosis: runnableDiagnosis(),
    inheritedMcpPolicy: options.inheritedMcpPolicy ?? "allow",
    mode: "non-interactive",
    startupTimeoutMs: 3_000,
    promptTimeoutMs: options.promptTimeoutMs ?? 3_000,
    postTurnLivenessMs: 50,
    env,
    runner: new ProcessRunner(),
  });
  return { ...bundle, deps: { ...bundle.deps, implementer: devin, devin } };
}

async function waitForState(file: string, expected: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fs.readFile(file, "utf8")).trim() === expected) return;
    } catch {
      // The fake process has not created the marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for fake Devin state ${expected} at ${file}`);
}

async function assertNoPublish(result: Awaited<ReturnType<typeof runDelivery>>, artifactRoot: string, bundle: ReturnType<typeof createFakeDeliveryDeps>) {
  expect(result.published).toBe(false);
  expect(bundle.git.calls.counts.commit).toBeUndefined();
  expect(bundle.git.calls.counts.push).toBeUndefined();
  expect(bundle.github.calls.counts.createDraftPullRequest).toBeUndefined();
  const implementation = result.implementation;
  expect(implementation?.artifactPaths.root).toBe(artifactRoot);
  if (implementation?.artifactPaths.termination) {
    const termination = JSON.parse(await fs.readFile(implementation.artifactPaths.termination, "utf8")) as {
      residualProcesses: number;
    };
    expect(termination.residualProcesses).toBe(0);
  }
}

describe("delivery workflow process boundary integration", () => {
  it("runs a CLI-compatible fake Devin ACP process through publish gates", async () => {
    const pair = await tempGitRepository();
    const bundle = await processBoundaryBundle(pair, "write-in-scope");

    const result = await runDelivery(input(pair), bundle.deps);

    expect(result.published).toBe(true);
    expect(result.status).toBe("awaiting_human");
    expect(result.implementation?.status).toBe("completed");
    expect(result.implementation?.changedFiles).toContain("README.md");
    expect(bundle.github.calls.counts.createDraftPullRequest).toBe(1);

    const artifactRoot = result.implementation?.artifactPaths.root;
    expect(artifactRoot).toBe(pair.artifactRoot);
    const termination = JSON.parse(
      await fs.readFile(path.join(artifactRoot!, "termination.json"), "utf8"),
    ) as { residualProcesses: number };
    expect(termination.residualProcesses).toBe(0);
    await expect(fs.access(path.join(artifactRoot!, "raw-events.jsonl"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(artifactRoot!, "events.jsonl"))).resolves.toBeUndefined();
  }, 15_000);

  it("exposes the fake CLI preflight entry points", async () => {
    const env = { ...process.env, MEGURIBI_FAKE_DEVIN_SCENARIO: "success" };
    const version = await execFileAsync(node(), [fakeDevin(), "--version"], { env });
    const auth = await execFileAsync(node(), [fakeDevin(), "auth", "status"], { env });
    const acpHelp = await execFileAsync(node(), [fakeDevin(), "acp", "--help"], { env });

    expect(version.stdout).toContain("3000.2.17");
    expect(auth.stdout).toContain("authenticated");
    expect(acpHelp.stdout).toContain("Start an ACP stdio session");
  });

  it("blocks permission-denied and protected-path scenarios before publishing", async () => {
    const pair = await tempGitRepository();
    const bundle = await processBoundaryBundle(pair, "permission-denied");

    const result = await runDelivery(input(pair), bundle.deps);

    expect(result.status).toBe("blocked");
    expect(result.reasons.some((reason) => /protected path|permission/i.test(reason))).toBe(true);
    await assertNoPublish(result, pair.artifactRoot, bundle);
  });

  it("blocks unexpected MCP output in a deny policy", async () => {
    const pair = await tempGitRepository();
    const bundle = await processBoundaryBundle(pair, "mcp-detected", {
      inheritedMcpPolicy: "deny",
    });

    const result = await runDelivery(
      input(pair, { inheritedMcpPolicy: "deny" }),
      bundle.deps,
    );

    expect(result.status).toBe("blocked");
    expect(result.reasons.some((reason) => /MCP|mcp/i.test(reason))).toBe(true);
    await assertNoPublish(result, pair.artifactRoot, bundle);
  });

  it("blocks commit, branch, and diff-limit violations", async () => {
    for (const scenario of ["commit-created", "branch-changed", "diff-limit"] as const) {
      const pair = await tempGitRepository();
      const bundle = await processBoundaryBundle(pair, scenario);
      const result = await runDelivery(input(pair), bundle.deps);

      expect(result.status).toBe("blocked");
      await assertNoPublish(result, pair.artifactRoot, bundle);
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")("detects a symlink escape at the process boundary", async () => {
    const pair = await tempGitRepository();
    const outsidePath = path.join(path.dirname(pair.cwd), "fake-symlink-target.txt");
    const bundle = await processBoundaryBundle(pair, "symlink-escape", { outsidePath });

    const result = await runDelivery(input(pair), bundle.deps);

    expect(result.status).toBe("blocked");
    expect(result.reasons.some((reason) => /symlink|worktree/i.test(reason))).toBe(true);
    await assertNoPublish(result, pair.artifactRoot, bundle);
  });

  it("preserves untracked changes and records reported-file mismatches as warnings", async () => {
    const untrackedPair = await tempGitRepository();
    const untrackedBundle = await processBoundaryBundle(untrackedPair, "write-untracked");
    const untracked = await runDelivery(input(untrackedPair, { noPr: true }), untrackedBundle.deps);
    expect(untracked.published).toBe(true);
    expect(untracked.implementation?.changedFiles).toContain("untracked.txt");

    const mismatchPair = await tempGitRepository();
    const mismatchBundle = await processBoundaryBundle(mismatchPair, "reported-files-mismatch");
    const mismatch = await runDelivery(input(mismatchPair, { noPr: true }), mismatchBundle.deps);
    expect(mismatch.published).toBe(true);
    const boundary = JSON.parse(
      await fs.readFile(path.join(mismatchPair.artifactRoot, "git-boundary.json"), "utf8"),
    ) as { warnings: string[] };
    expect(boundary.warnings).toContain("Devin reported files differ from Git diff");
  }, 20_000);

  it("does not publish after an ACP timeout and reclaims process trees", async () => {
    const pair = await tempGitRepository();
    const bundle = await processBoundaryBundle(pair, "timeout", { promptTimeoutMs: 200 });

    const result = await runDelivery(input(pair), bundle.deps);

    expect(result.status).toBe("timed_out");
    await assertNoPublish(result, pair.artifactRoot, bundle);
  }, 15_000);

  it("force-terminates a SIGTERM-ignoring ACP and reclaims grandchildren", async () => {
    for (const scenario of ["sigterm-ignore", "process-tree"] as const) {
      const pair = await tempGitRepository();
      const bundle = await processBoundaryBundle(pair, scenario);
      const result = await runDelivery(input(pair, { noPr: true }), bundle.deps);

      expect(result.published).toBe(true);
      const termination = JSON.parse(
        await fs.readFile(path.join(pair.artifactRoot, "termination.json"), "utf8"),
      ) as { residualProcesses: number; forceKillUsed?: boolean };
      expect(termination.residualProcesses).toBe(0);
      if (scenario === "sigterm-ignore") expect(termination.forceKillUsed).toBe(true);
    }
  }, 20_000);

  it("cancels an in-flight ACP prompt without leaving processes", async () => {
    const pair = await tempGitRepository();
    const stateFile = path.join(pair.artifactRoot, "fake-state.txt");
    const bundle = await processBoundaryBundle(pair, "cancel", { stateFile });
    const controller = new AbortController();
    const pending = runDelivery(input(pair, { abortSignal: controller.signal }), bundle.deps);

    await waitForState(stateFile, "prompt-started");
    controller.abort();
    const result = await pending;

    expect(result.status).toBe("cancelled");
    await assertNoPublish(result, pair.artifactRoot, bundle);
  }, 15_000);

  it("persists redacted events and authoritative artifact metadata", async () => {
    const pair = await tempGitRepository();
    const bundle = await processBoundaryBundle(pair, "secret-in-events");

    const result = await runDelivery(input(pair, { noPr: true }), bundle.deps);

    expect(result.published).toBe(true);
    const root = result.implementation?.artifactPaths.root;
    expect(root).toBe(pair.artifactRoot);
    const raw = await fs.readFile(path.join(root!, "raw-events.jsonl"), "utf8");
    const events = await fs.readFile(path.join(root!, "events.jsonl"), "utf8");
    expect(raw).not.toContain("supersecrettoken123");
    expect(events).not.toContain("supersecrettoken123");
    expect(raw).toContain("[REDACTED]");
    const termination = JSON.parse(await fs.readFile(path.join(root!, "termination.json"), "utf8")) as {
      residualProcesses: number;
    };
    expect(termination.residualProcesses).toBe(0);
  });

  it("runs a verifier fix through a second real ACP process", async () => {
    const pair = await tempGitRepository();
    const bundle = await processBoundaryBundle(pair, "write-in-scope");
    const deps = {
      ...bundle.deps,
      verifier: createFakeDeliveryDeps({ verifier: { failFirstN: 1 } }).verifier,
    };

    const result = await runDelivery(input(pair), deps);

    expect(result.published).toBe(true);
    expect(result.status).toBe("awaiting_human");
  }, 20_000);
});
