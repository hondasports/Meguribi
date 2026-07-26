import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import type { DevinDiagnosis, ImplementationContext } from "@meguribi/core";
import { ProcessRunner } from "@meguribi/process";
import { createDevinAcpAdapter } from "./acp-adapter.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  // Allow late ACP shutdown writers to finish before deleting temp dirs.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function node(): string {
  return process.execPath;
}

function fakeAcpServer(): string {
  return fileURLToPath(new URL("./fixtures/fake-acp-server.js", import.meta.url));
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

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function tempGit(): Promise<{ cwd: string; artifactRoot: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-acp-adapter-cwd-"));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-acp-adapter-art-"));
  tempDirs.push(cwd, artifactRoot);
  await fs.writeFile(path.join(cwd, "README.md"), "# fixture\n", "utf8");
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "user.name", "Meguribi Test");
  await git(cwd, "add", "README.md");
  await git(cwd, "commit", "-m", "fixture");
  return { cwd, artifactRoot };
}

function contextFor(cwd: string, extras?: Partial<ImplementationContext>): ImplementationContext {
  return {
    issue: { source: "issue", content: "implement the fixture" },
    comments: [],
    acceptanceCriteria: ["the fixture completes"],
    plan: { summary: "complete fixture", steps: ["run the fixture"] },
    repositoryRules: "Do not commit.",
    primarySkill: "testing",
    verificationCommands: ["pnpm test"],
    protectedPaths: [".env*"],
    worktreePath: cwd,
    allowedPaths: ["."],
    limits: { maxPromptChars: 10_000, maxChangedFiles: 10, maxDiffLines: 100 },
    expectedResult: ["report completion"],
    ...extras,
  };
}

describe("createDevinAcpAdapter integration", () => {
  it("implements successfully with Git-authoritative changed files", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const adapter = createDevinAcpAdapter({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      diagnosis: runnableDiagnosis(),
      inheritedMcpPolicy: "allow",
      mode: "non-interactive",
      startupTimeoutMs: 5_000,
      postTurnLivenessMs: 50,
      env: { ...process.env, FAKE_ACP_MODE: "write-in-scope" },
      runner: new ProcessRunner(),
    });

    const result = await adapter.implement({
      context: contextFor(cwd),
      artifactRoot,
      gitBoundary: {
        expectedRemoteIdentity: "",
        expectedBaseSha: "",
        expectedBranch: "main",
        outsidePaths: [],
        protectedPaths: [".env*"],
        maxChangedFiles: 10,
        maxDiffLines: 100,
      },
    });

    expect(result.status).toBe("completed");
    expect(result.publishable).toBe(true);
    expect(result.changedFiles.length).toBeGreaterThan(0);
    const prompt = await fs.readFile(path.join(artifactRoot, "devin-prompt.md"), "utf8");
    expect(prompt).toContain("implement the fixture");
    expect(prompt).toContain("<untrusted-content>");
    expect(prompt).not.toContain("run approved implementation");
    expect(result.sessionId).not.toBe("none");
    expect(result.artifactPaths.root).toBe(artifactRoot);
  });

  it("fixes with fixInstruction", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const adapter = createDevinAcpAdapter({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      diagnosis: runnableDiagnosis(),
      inheritedMcpPolicy: "allow",
      mode: "non-interactive",
      startupTimeoutMs: 5_000,
      postTurnLivenessMs: 50,
      env: { ...process.env, FAKE_ACP_MODE: "write-in-scope" },
      runner: new ProcessRunner(),
    });

    const result = await adapter.fix({
      context: contextFor(cwd, {
        fixInstruction: { source: "meguribi-fix", content: "fix the failing test" },
      }),
      artifactRoot,
      gitBoundary: {
        expectedRemoteIdentity: "",
        expectedBaseSha: "",
        expectedBranch: "main",
        outsidePaths: [],
        protectedPaths: [".env*"],
        maxChangedFiles: 10,
        maxDiffLines: 100,
      },
    });

    expect(result.status).toBe("completed");
    expect(result.publishable).toBe(true);
  });

  it("allows fix to rewrite the same file after implement", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const adapter = createDevinAcpAdapter({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      diagnosis: runnableDiagnosis(),
      inheritedMcpPolicy: "allow",
      mode: "non-interactive",
      startupTimeoutMs: 5_000,
      postTurnLivenessMs: 50,
      env: { ...process.env, FAKE_ACP_MODE: "write-in-scope" },
      runner: new ProcessRunner(),
    });
    const boundary = {
      expectedRemoteIdentity: "",
      expectedBaseSha: "",
      expectedBranch: "main",
      outsidePaths: [] as string[],
      protectedPaths: [".env*"],
      maxChangedFiles: 10,
      maxDiffLines: 100,
    };

    const implemented = await adapter.implement({
      context: contextFor(cwd),
      artifactRoot,
      gitBoundary: boundary,
    });
    expect(implemented.status).toBe("completed");
    expect(implemented.changedFiles).toContain("README.md");

    const fixRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-acp-adapter-fix-"));
    tempDirs.push(fixRoot);
    const fixed = await adapter.fix({
      context: contextFor(cwd, {
        fixInstruction: { source: "meguribi-fix", content: "rewrite README again" },
      }),
      artifactRoot: fixRoot,
      gitBoundary: boundary,
    });

    expect(fixed.status).toBe("completed");
    expect(fixed.publishable).toBe(true);
    expect(fixed.changedFiles).toContain("README.md");
    expect(fixed.error?.message ?? "").not.toMatch(/pre-existing dirty/i);
  }, 20_000);

  it("blocks when preflight diagnosis is not runnable", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const adapter = createDevinAcpAdapter({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      diagnosis: {
        ...runnableDiagnosis(),
        runnable: false,
        authentication: { status: "unauthenticated" },
        errors: [{ code: "unauthenticated", message: "not logged in" }],
      },
      inheritedMcpPolicy: "allow",
      mode: "non-interactive",
      startupTimeoutMs: 5_000,
      runner: new ProcessRunner(),
    });

    const result = await adapter.implement({
      context: contextFor(cwd),
      artifactRoot,
      gitBoundary: {
        expectedRemoteIdentity: "",
        expectedBaseSha: "",
        expectedBranch: "main",
        outsidePaths: [],
        protectedPaths: [".env*"],
        maxChangedFiles: 10,
        maxDiffLines: 100,
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.publishable).toBe(false);
    expect(result.error?.code).toBe("policy_blocked");
  });

  it("blocks MCP warn policy in non-interactive mode", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const adapter = createDevinAcpAdapter({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      diagnosis: runnableDiagnosis(),
      inheritedMcpPolicy: "warn",
      mode: "non-interactive",
      explicitAllowInheritedMcp: false,
      startupTimeoutMs: 5_000,
      runner: new ProcessRunner(),
    });

    const result = await adapter.implement({
      context: contextFor(cwd),
      artifactRoot,
      gitBoundary: {
        expectedRemoteIdentity: "",
        expectedBaseSha: "",
        expectedBranch: "main",
        outsidePaths: [],
        protectedPaths: [".env*"],
        maxChangedFiles: 10,
        maxDiffLines: 100,
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.mcpPolicyResult?.outcome).toBe("block");
  });

  it("blocks protected path changes", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const adapter = createDevinAcpAdapter({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      diagnosis: runnableDiagnosis(),
      inheritedMcpPolicy: "allow",
      mode: "non-interactive",
      startupTimeoutMs: 5_000,
      postTurnLivenessMs: 50,
      env: { ...process.env, FAKE_ACP_MODE: "write-protected" },
      runner: new ProcessRunner(),
    });

    const result = await adapter.implement({
      context: contextFor(cwd),
      artifactRoot,
      gitBoundary: {
        expectedRemoteIdentity: "",
        expectedBaseSha: "",
        expectedBranch: "main",
        outsidePaths: [],
        protectedPaths: [".env*"],
        maxChangedFiles: 10,
        maxDiffLines: 100,
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.publishable).toBe(false);
  });

  it("cancels when abortSignal is already aborted", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const adapter = createDevinAcpAdapter({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      diagnosis: runnableDiagnosis(),
      inheritedMcpPolicy: "allow",
      mode: "non-interactive",
      startupTimeoutMs: 5_000,
      env: { ...process.env, FAKE_ACP_MODE: "success" },
      runner: new ProcessRunner(),
    });
    const controller = new AbortController();
    controller.abort();

    const result = await adapter.implement({
      context: contextFor(cwd),
      artifactRoot,
      gitBoundary: {
        expectedRemoteIdentity: "",
        expectedBaseSha: "",
        expectedBranch: "main",
        outsidePaths: [],
        protectedPaths: [".env*"],
        maxChangedFiles: 10,
        maxDiffLines: 100,
      },
      abortSignal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(result.publishable).toBe(false);
  });

  it("rejects fix without fixInstruction", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const adapter = createDevinAcpAdapter({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      diagnosis: runnableDiagnosis(),
      inheritedMcpPolicy: "allow",
      mode: "non-interactive",
      startupTimeoutMs: 5_000,
      runner: new ProcessRunner(),
    });

    const result = await adapter.fix({
      context: contextFor(cwd),
      artifactRoot,
      gitBoundary: {
        expectedRemoteIdentity: "",
        expectedBaseSha: "",
        expectedBranch: "main",
        outsidePaths: [],
        protectedPaths: [".env*"],
        maxChangedFiles: 10,
        maxDiffLines: 100,
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("malformed_message");
  });
});
