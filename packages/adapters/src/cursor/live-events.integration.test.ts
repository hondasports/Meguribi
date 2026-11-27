import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import type { AgentDiagnosis, AgentEvent, ImplementationContext } from "@meguribi/core";
import { ProcessRunner } from "@meguribi/process";
import { createCursorAcpAdapter } from "./acp-adapter.js";

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
  return fileURLToPath(new URL("../devin/fixtures/fake-acp-server.js", import.meta.url));
}

function runnableDiagnosis(): AgentDiagnosis {
  return {
    executable: { status: "ok", path: node() },
    version: { status: "supported", raw: "0.1.0" },
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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-live-events-cwd-"));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-live-events-art-"));
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

describe("createCursorAcpAdapter live events", () => {
  it("forwards normalized agent events to input.onEvent during implement", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const adapter = createCursorAcpAdapter({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      diagnosis: runnableDiagnosis(),
      inheritedMcpPolicy: "allow",
      mode: "non-interactive",
      startupTimeoutMs: 5_000,
      postTurnLivenessMs: 50,
      env: { ...process.env, FAKE_ACP_MODE: "success" },
      runner: new ProcessRunner(),
    });

    const events: AgentEvent[] = [];
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
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.status).toBe("completed");
    const types = events.map((event) => event.type);
    const messageIndex = types.indexOf("message.delta");
    const toolStartedIndex = types.indexOf("tool.started");
    const toolCompletedIndex = types.indexOf("tool.completed");
    expect(messageIndex).toBeGreaterThanOrEqual(0);
    expect(toolStartedIndex).toBeGreaterThan(messageIndex);
    expect(toolCompletedIndex).toBeGreaterThan(toolStartedIndex);
    const firstMessage = events.find((event) => event.type === "message.delta");
    expect(firstMessage).toMatchObject({ text: "fake ACP connected" });
  });
});
