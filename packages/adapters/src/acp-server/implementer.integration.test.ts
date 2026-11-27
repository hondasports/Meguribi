import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDiagnosis, AgentProfile, ImplementationContext } from "@meguribi/core";
import { ProcessRunner } from "@meguribi/process";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function node(): string {
  return process.execPath;
}

function fakeAcpServer(): string {
  return fileURLToPath(new URL("../devin/fixtures/fake-acp-server.js", import.meta.url));
}

function claudeCodeProfile(): AgentProfile {
  return {
    id: "claude-code",
    kind: "claude-code",
    transport: "acp",
    executable: "claude-agent-acp",
    startupTimeoutMs: 10_000,
    turnTimeoutMinutes: 45,
    inheritedMcpPolicy: "allow",
  };
}

function runnableDiagnosis(): AgentDiagnosis {
  return {
    executable: { status: "ok", path: node() },
    version: { status: "unknown" },
    authentication: { status: "unknown" },
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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-acp-impl-cwd-"));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-acp-impl-art-"));
  tempDirs.push(cwd, artifactRoot);
  await fs.writeFile(path.join(cwd, "README.md"), "# fixture\n", "utf8");
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "user.name", "Meguribi Test");
  await git(cwd, "add", "README.md");
  await git(cwd, "commit", "-m", "fixture");
  return { cwd, artifactRoot };
}

function contextFor(cwd: string): ImplementationContext {
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
  };
}

async function implementerOptions(
  fakeMode: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{
  create: (typeof import("./implementer.js"))["createAcpServerImplementer"];
  options: Parameters<(typeof import("./implementer.js"))["createAcpServerImplementer"]>[0];
}> {
  const { createAcpServerImplementer } = await import("./implementer.js");
  return {
    create: createAcpServerImplementer,
    options: {
      profile: claudeCodeProfile(),
      executable: node(),
      executableArgs: [fakeAcpServer()],
      diagnosis: runnableDiagnosis(),
      inheritedMcpPolicy: "allow",
      mode: "non-interactive",
      startupTimeoutMs: 5_000,
      promptTimeoutMs: 5_000,
      postTurnLivenessMs: 50,
      env: { ...process.env, FAKE_ACP_MODE: fakeMode, ...extraEnv },
      runner: new ProcessRunner(),
    },
  };
}

describe("createAcpServerImplementer integration", () => {
  it("implements through a standalone ACP server and persists the profile prompt artifact", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const { create, options } = await implementerOptions("write-in-scope");
    const adapter = create(options);

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
    expect(result.changedFiles).toContain("README.md");
    expect(result.artifactPaths.root).toBe(artifactRoot);
    await expect(fs.access(path.join(artifactRoot, "claude-code-prompt.md"))).resolves.toBeUndefined();
    const promptMetadata = JSON.parse(
      await fs.readFile(path.join(artifactRoot, "prompt.json"), "utf8"),
    ) as { version?: string };
    expect(promptMetadata.version).toBe("meguribi-acp-prompt/v1");
  });

  it("blocks publication when the standalone ACP server writes outside the worktree", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const outsidePath = path.join(artifactRoot, "outside.txt");
    const { create, options } = await implementerOptions("write-outside", {
      MEGURIBI_FAKE_OUTSIDE_PATH: outsidePath,
    });
    const adapter = create(options);

    const result = await adapter.implement({
      context: contextFor(cwd),
      artifactRoot,
      gitBoundary: {
        expectedRemoteIdentity: "",
        expectedBaseSha: "",
        expectedBranch: "main",
        outsidePaths: [outsidePath],
        protectedPaths: [".env*"],
        maxChangedFiles: 10,
        maxDiffLines: 100,
      },
    });

    expect(result.publishable).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("policy_blocked");
  });
});
