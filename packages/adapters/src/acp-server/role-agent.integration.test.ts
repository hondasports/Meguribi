import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import type { AgentDiagnosis, AgentEvent, AgentProfile } from "@meguribi/core";
import { createAcpRoleAgent, RoleSessionWriteViolationError } from "./role-agent.js";
import { AcpAgentArtifactStore } from "../acp/artifact-store.js";
import type { AcpConnection, AcpTransport } from "../acp/transport.js";

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

function claudeCodeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "claude-code",
    kind: "claude-code",
    transport: "acp",
    executable: "claude-agent-acp",
    startupTimeoutMs: 10_000,
    turnTimeoutMinutes: 45,
    inheritedMcpPolicy: "allow",
    ...overrides,
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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-role-agent-cwd-"));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-role-agent-art-"));
  tempDirs.push(cwd, artifactRoot);
  await fs.writeFile(path.join(cwd, "README.md"), "# fixture\n", "utf8");
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "user.name", "Meguribi Test");
  await git(cwd, "add", "README.md");
  await git(cwd, "commit", "-m", "fixture");
  return { cwd, artifactRoot };
}

function agentFor(mode: string): ReturnType<typeof createAcpRoleAgent> {
  return createAcpRoleAgent({
    profile: claudeCodeProfile(),
    executable: node(),
    executableArgs: [fakeAcpServer()],
    diagnosis: runnableDiagnosis(),
    mode: "non-interactive",
    env: { ...process.env, FAKE_ACP_MODE: mode },
  });
}

function fakeTransportConnection(sessionId: string): AcpConnection {
  const startedAt = new Date().toISOString();
  const exit = {
    code: 0,
    signal: null,
    startedAt,
    finishedAt: startedAt,
  };
  return {
    sessionId,
    protocolVersion: 1,
    supportsSessionLoad: false,
    stderrText: () => "",
    mcpSecurityAlert: () => undefined,
    mcpWarning: () => undefined,
    awaitStderrDrain: async () => undefined,
    prompt: async function* () {},
    cancel: async () => undefined,
    closeInput: async () => undefined,
    waitForProcessExit: async () => exit,
    terminate: async () => exit,
    loadSession: async (input) => ({ sessionId: input.sessionId }),
  };
}

describe("createAcpRoleAgent integration", () => {
  it("passes configured acpArgs to the transport and defaults to an empty array", async () => {
    const startedAcpArgs: (string[] | undefined)[] = [];
    const transport: AcpTransport = {
      start: async (input) => {
        startedAcpArgs.push(input.acpArgs);
        return fakeTransportConnection(`fake-transport-${startedAcpArgs.length}`);
      },
    };
    const { cwd, artifactRoot } = await tempGit();
    const openAndClose = async (acpArgs: string[] | undefined, artifactName: string) => {
      const agent = createAcpRoleAgent({
        profile: claudeCodeProfile(),
        executable: "fake-agent-cli",
        diagnosis: runnableDiagnosis(),
        mode: "non-interactive",
        transport,
        ...(acpArgs !== undefined ? { acpArgs } : {}),
      });
      const session = await agent.openSession({
        cwd,
        mode: "read-only",
        role: "planner",
        artifactRoot: path.join(artifactRoot, artifactName),
      });
      await session.close();
    };

    await openAndClose(["acp"], "with-acp-args");
    await openAndClose(undefined, "without-acp-args");

    expect(startedAcpArgs).toEqual([["acp"], []]);
  });

  it("streams events to onEvent and returns concatenated text for a read-only turn", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const agent = agentFor("success");
    const events: AgentEvent[] = [];
    const streaming = await agent.openSession({
      cwd,
      mode: "read-only",
      role: "planner",
      artifactRoot,
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      const result = await streaming.send({ content: "hi" });
      expect(result.text).toBe("fake ACP connectedfake ACP completed");
      expect(result.stopReason).toBe("end_turn");
      expect(result.sessionId).toBe(streaming.sessionId);
    } finally {
      await streaming.close();
    }
    const message = events.find((event) => event.type === "message.delta");
    expect(message).toMatchObject({ type: "message.delta", text: "fake ACP connected" });
  });

  it("supports multiple sequential sends on the same session", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const agent = agentFor("success");
    const session = await agent.openSession({
      cwd,
      mode: "read-only",
      role: "planner",
      artifactRoot,
    });
    try {
      const first = await session.send({ content: "first" });
      const second = await session.send({ content: "second" });
      expect(first.stopReason).toBe("end_turn");
      expect(second.stopReason).toBe("end_turn");
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.text).toContain("fake ACP connected");
    } finally {
      await session.close();
    }
  });

  it("detects direct writes in a read-only session and throws RoleSessionWriteViolationError", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const agent = agentFor("write-in-scope");
    const session = await agent.openSession({
      cwd,
      mode: "read-only",
      role: "planner",
      artifactRoot,
    });
    let violation: unknown;
    try {
      await session.send({ content: "hi" }).catch((error: unknown) => {
        violation = error;
      });
      expect(violation).toBeInstanceOf(RoleSessionWriteViolationError);
      expect((violation as RoleSessionWriteViolationError).code).toBe("policy_blocked");
      expect((violation as RoleSessionWriteViolationError).changedFiles.length).toBeGreaterThan(0);
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it("denies permission requests in read-only sessions", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const agent = agentFor("permission");
    const events: AgentEvent[] = [];
    const session = await agent.openSession({
      cwd,
      mode: "read-only",
      role: "planner",
      artifactRoot,
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      await session.send({ content: "hi" });
    } finally {
      await session.close().catch(() => undefined);
    }
    const approval = events.find((event) => event.type === "approval.required");
    expect(approval).toBeDefined();
    expect(approval).toMatchObject({ decision: { outcome: "deny" } });
  });

  it("persists the termination artifact on close and tolerates a double close", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const agent = agentFor("success");
    const abort = new AbortController();
    const session = await agent.openSession({
      cwd,
      mode: "read-only",
      role: "planner",
      artifactRoot,
      abortSignal: abort.signal,
    });
    await session.send({ content: "hi" });
    await session.close();

    const store = new AcpAgentArtifactStore(artifactRoot, {
      label: "Claude Code",
      promptFileName: "claude-code-prompt.md",
    });
    await expect(fs.access(store.terminationPath)).resolves.toBeUndefined();
    const termination = JSON.parse(await fs.readFile(store.terminationPath, "utf8")) as {
      reason?: string;
    };
    expect(termination.reason).toBe("completed");

    await expect(session.close()).resolves.toBeUndefined();
  });

  it.each([
    { profilePolicy: "warn", runPolicy: "allow", expected: "allow" },
    { profilePolicy: "warn", runPolicy: "deny", expected: "deny" },
    { profilePolicy: "allow", runPolicy: "deny", expected: "deny" },
    { profilePolicy: "deny", runPolicy: "allow", expected: "deny" },
    { profilePolicy: "warn", runPolicy: undefined, expected: "warn" },
  ] as const)(
    "passes the effective MCP policy to the actual ACP session ($profilePolicy + $runPolicy)",
    async ({ profilePolicy, runPolicy, expected }) => {
      const startedMcpPolicies: unknown[] = [];
      const transport: AcpTransport = {
        start: async (input) => {
          startedMcpPolicies.push(input.mcpPolicy);
          return fakeTransportConnection("fake-transport-mcp-policy");
        },
      };
      const { cwd, artifactRoot } = await tempGit();
      const options = {
        profile: claudeCodeProfile({ inheritedMcpPolicy: profilePolicy }),
        executable: "fake-agent-cli",
        diagnosis: runnableDiagnosis(),
        mode: "non-interactive" as const,
        transport,
        ...(runPolicy === undefined ? {} : { discussionMcpPolicy: runPolicy }),
      };
      const agent = createAcpRoleAgent(options);
      const session = await agent.openSession({
        cwd,
        mode: "read-only",
        role: "planner",
        artifactRoot,
      });
      await session.close();

      expect(startedMcpPolicies).toHaveLength(1);
      expect(startedMcpPolicies[0]).toMatchObject({
        policy: expected,
        mode: "non-interactive",
        explicitAllow: false,
      });
    },
  );

  it("does not raise write violations in write mode", async () => {
    const { cwd, artifactRoot } = await tempGit();
    const agent = agentFor("write-in-scope");
    const session = await agent.openSession({
      cwd,
      mode: "write",
      role: "implementer",
      artifactRoot,
    });
    try {
      const result = await session.send({ content: "hi" });
      expect(result.stopReason).toBe("end_turn");
    } finally {
      await expect(session.close()).resolves.toBeUndefined();
    }
  });
});
