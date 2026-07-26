import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import type { AgentEvent, DevinDiagnosis } from "@meguribi/core";
import { ProcessRunner } from "@meguribi/process";
import { startDevinAcpSession } from "./session.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
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

async function tempPair(): Promise<{ cwd: string; artifactRoot: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-devin-session-cwd-"));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-devin-session-art-"));
  tempDirs.push(cwd, artifactRoot);
  await fs.writeFile(path.join(cwd, "README.md"), "# fixture\n", "utf8");
  return { cwd, artifactRoot };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function tempGitPair(): Promise<{ cwd: string; artifactRoot: string }> {
  const pair = await tempPair();
  await git(pair.cwd, "init", "-b", "main");
  await git(pair.cwd, "config", "user.email", "test@example.invalid");
  await git(pair.cwd, "config", "user.name", "Meguribi Test");
  await git(pair.cwd, "add", "README.md");
  await git(pair.cwd, "commit", "-m", "fixture");
  return pair;
}

async function collectEvents(
  mode: string,
  withImplementationContext = false,
): Promise<{ events: AgentEvent[]; artifactRoot: string; sessionId: string }> {
  const { cwd, artifactRoot } = await tempPair();
  const session = await startDevinAcpSession({
    executable: node(),
    executableArgs: [fakeAcpServer()],
    acpArgs: [],
    cwd,
    env: { ...process.env, FAKE_ACP_MODE: mode },
    startupTimeoutMs: 5_000,
    postTurnLivenessMs: 50,
    diagnosis: runnableDiagnosis(),
    runner: new ProcessRunner(),
    artifactRoot,
    ...(withImplementationContext ? {
      implementationContext: {
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
      },
    } : {}),
  });

  const promptEvents: AgentEvent[] = [];
  for await (const event of session.prompt({ content: "implement fixture" })) {
    promptEvents.push(event);
  }
  await session.finish({
    status: "completed",
    sessionId: session.sessionId,
    stopReason: "end_turn",
  });
  return {
    events: promptEvents,
    artifactRoot,
    sessionId: session.sessionId,
  };
}

describe("startDevinAcpSession integration", () => {
  it("normalizes events and writes raw/normalized JSONL artifacts", async () => {
    const { events, artifactRoot, sessionId } = await collectEvents("success");
    expect(events.some((event) => event.type === "message.delta")).toBe(true);
    expect(events.some((event) => event.type === "tool.started")).toBe(true);
    expect(events.some((event) => event.type === "tool.completed")).toBe(true);
    expect(events.some((event) => event.type === "file.changed")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      stopReason: "end_turn",
      sessionId,
    });

    const rawLines = (await fs.readFile(path.join(artifactRoot, "raw-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sequence: number });
    const eventLines = (await fs.readFile(path.join(artifactRoot, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sequence: number; event: AgentEvent });

    expect(eventLines[0]?.event.type).toBe("session.started");
    expect(rawLines.length).toBeGreaterThan(0);
    expect(eventLines.some((line) => line.event.type === "message.delta")).toBe(true);
    // Shared sequence space: every raw record sequence appears in normalized events.
    const eventSequences = new Set(eventLines.map((line) => line.sequence));
    for (const raw of rawLines) {
      expect(eventSequences.has(raw.sequence)).toBe(true);
    }

    const session = JSON.parse(
      await fs.readFile(path.join(artifactRoot, "session.json"), "utf8"),
    ) as { sessionId: string; stopReason?: string };
    const result = JSON.parse(
      await fs.readFile(path.join(artifactRoot, "result.json"), "utf8"),
    ) as { status: string };
    expect(session.sessionId).toBe(sessionId);
    expect(session.stopReason).toBe("end_turn");
    expect(result.status).toBe("completed");
    const termination = JSON.parse(
      await fs.readFile(path.join(artifactRoot, "termination.json"), "utf8"),
    ) as { stdinClosed: boolean; residualProcesses: number };
    expect(termination.stdinClosed).toBe(true);
    expect(termination.residualProcesses).toBe(0);
  });

  it("redacts secrets in persisted message artifacts and yielded events", async () => {
    const { artifactRoot, events } = await collectEvents("secret-in-message");
    const raw = await fs.readFile(path.join(artifactRoot, "raw-events.jsonl"), "utf8");
    const eventLog = await fs.readFile(path.join(artifactRoot, "events.jsonl"), "utf8");
    expect(raw.includes("supersecrettoken123")).toBe(false);
    expect(eventLog.includes("supersecrettoken123")).toBe(false);
    expect(raw.includes("[REDACTED]") || eventLog.includes("[REDACTED]")).toBe(true);

    const deltas = events.filter(
      (event): event is Extract<AgentEvent, { type: "message.delta" }> =>
        event.type === "message.delta",
    );
    expect(deltas.length).toBeGreaterThan(0);
    for (const delta of deltas) {
      expect(delta.text.includes("supersecrettoken123")).toBe(false);
      expect(delta.text.includes("Bearer abc.def.ghi")).toBe(false);
    }
    expect(deltas.some((delta) => delta.text.includes("[REDACTED]"))).toBe(true);
  });

  it("maps thought chunks to unknown without treating them as turn completion", async () => {
    const { events } = await collectEvents("unknown-update");
    expect(events.some((event) => event.type === "unknown")).toBe(true);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("persists approval.required for permission requests", async () => {
    const { events } = await collectEvents("permission");
    expect(events).toContainEqual(expect.objectContaining({
      type: "approval.required",
      decision: expect.objectContaining({ outcome: "deny" }),
    }));
  });

  it("builds and persists the constrained prompt artifact", async () => {
    const { artifactRoot } = await collectEvents("success", true);
    const prompt = await fs.readFile(path.join(artifactRoot, "devin-prompt.md"), "utf8");
    const metadata = JSON.parse(await fs.readFile(path.join(artifactRoot, "prompt.json"), "utf8")) as {
      version: string;
      hash: string;
    };
    expect(prompt).toContain("[MEGURIBI SYSTEM CONTRACT]");
    expect(metadata.version).toBe("meguribi-devin-prompt/v1");
    expect(metadata.hash).toMatch(/^sha256:/);
  });

  it("persists stderr.log when prompt fails", async () => {
    const { cwd, artifactRoot } = await tempPair();
    const session = await startDevinAcpSession({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      cwd,
      env: { ...process.env, FAKE_ACP_MODE: "connection-close-mid-prompt" },
      startupTimeoutMs: 5_000,
      diagnosis: runnableDiagnosis(),
      runner: new ProcessRunner(),
      artifactRoot,
    });

    await expect(async () => {
      for await (const _event of session.prompt({ content: "implement fixture" })) {
        // drain until transport failure
      }
    }).rejects.toBeTruthy();

    const stderr = await fs.readFile(path.join(artifactRoot, "stderr.log"), "utf8");
    expect(stderr).toContain(`cwd=${cwd}`);
    const eventLog = await fs.readFile(path.join(artifactRoot, "events.jsonl"), "utf8");
    expect(eventLog).toContain("session.failed");
    const termination = JSON.parse(await fs.readFile(path.join(artifactRoot, "termination.json"), "utf8")) as {
      reason: string;
      residualProcesses: number;
    };
    expect(termination.reason).toBe("crashed");
    expect(termination.residualProcesses).toBe(0);
  });

  it("blocks result publication when the Git boundary detects a protected change", async () => {
    const { cwd, artifactRoot } = await tempGitPair();
    const session = await startDevinAcpSession({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      cwd,
      env: { ...process.env, FAKE_ACP_MODE: "write-protected" },
      startupTimeoutMs: 5_000,
      postTurnLivenessMs: 50,
      diagnosis: runnableDiagnosis(),
      runner: new ProcessRunner(),
      artifactRoot,
      gitBoundary: {
        expectedRemoteIdentity: "",
        expectedBranch: "main",
        protectedPaths: [".env*"],
        maxChangedFiles: 10,
        maxDiffLines: 100,
      },
    });

    for await (const _event of session.prompt({ content: "implement fixture" })) {
      // drain the fake turn
    }
    await expect(session.finish({
      status: "completed",
      sessionId: session.sessionId,
      stopReason: "end_turn",
    })).rejects.toThrow("Git/worktree safety boundary blocked publishing");
    const boundary = JSON.parse(await fs.readFile(path.join(artifactRoot, "git-boundary.json"), "utf8")) as {
      publishable: boolean;
      reasons: string[];
    };
    const result = JSON.parse(await fs.readFile(path.join(artifactRoot, "result.json"), "utf8")) as { status: string };
    expect(boundary.publishable).toBe(false);
    expect(boundary.reasons).toContain("protected path changed");
    expect(result.status).toBe("blocked");
  });

  it("persists the MCP security alert before terminating the session", async () => {
    const { cwd, artifactRoot } = await tempPair();
    const session = await startDevinAcpSession({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      cwd,
      env: { ...process.env, FAKE_ACP_MODE: "mcp-stderr" },
      startupTimeoutMs: 5_000,
      promptTimeoutMs: 5_000,
      diagnosis: runnableDiagnosis(),
      runner: new ProcessRunner(),
      artifactRoot,
      mcpPolicy: { policy: "deny", mode: "non-interactive", explicitAllow: false },
    });

    await expect(async () => {
      for await (const _event of session.prompt({ content: "implement fixture" })) {
        // drain until policy termination
      }
    }).rejects.toMatchObject({ code: "policy_blocked" });
    const stderr = await fs.readFile(path.join(artifactRoot, "stderr.log"), "utf8");
    const termination = JSON.parse(await fs.readFile(path.join(artifactRoot, "termination.json"), "utf8")) as { residualProcesses: number };
    expect(stderr).toContain("SECURITY_ALERT: unexpected-mcp-connection");
    expect(termination.residualProcesses).toBe(0);
  });

  it("persists a warning when reported files differ from the Git diff", async () => {
    const { cwd, artifactRoot } = await tempGitPair();
    const session = await startDevinAcpSession({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      cwd,
      env: { ...process.env, FAKE_ACP_MODE: "write-in-scope" },
      startupTimeoutMs: 5_000,
      postTurnLivenessMs: 50,
      diagnosis: runnableDiagnosis(),
      runner: new ProcessRunner(),
      artifactRoot,
      gitBoundary: {
        expectedRemoteIdentity: "",
        expectedBranch: "main",
        maxChangedFiles: 10,
        maxDiffLines: 100,
      },
    });
    for await (const _event of session.prompt({ content: "implement fixture" })) {
      // drain the fake turn
    }
    await session.finish({
      status: "completed",
      sessionId: session.sessionId,
      stopReason: "end_turn",
      reportedFiles: ["wrong.ts"],
    });
    const boundary = JSON.parse(await fs.readFile(path.join(artifactRoot, "git-boundary.json"), "utf8")) as {
      publishable: boolean;
      warnings: string[];
    };
    expect(boundary.publishable).toBe(true);
    expect(boundary.warnings).toContain("Devin reported files differ from Git diff");
  });

  it("fails closed when a repository session omits Git boundary configuration", async () => {
    const { cwd, artifactRoot } = await tempGitPair();
    const session = await startDevinAcpSession({
      executable: node(),
      executableArgs: [fakeAcpServer()],
      acpArgs: [],
      cwd,
      env: { ...process.env, FAKE_ACP_MODE: "success" },
      startupTimeoutMs: 5_000,
      diagnosis: runnableDiagnosis(),
      runner: new ProcessRunner(),
      artifactRoot,
    });
    for await (const _event of session.prompt({ content: "implement fixture" })) {
      // drain the fake turn
    }
    await expect(session.finish({
      status: "completed",
      sessionId: session.sessionId,
      stopReason: "end_turn",
    })).rejects.toThrow("Git/worktree safety boundary blocked publishing");
    const boundary = JSON.parse(await fs.readFile(path.join(artifactRoot, "git-boundary.json"), "utf8")) as {
      verdict: string;
      publishable: boolean;
    };
    expect(boundary).toMatchObject({ verdict: "suspicious", publishable: false });
  });
});
