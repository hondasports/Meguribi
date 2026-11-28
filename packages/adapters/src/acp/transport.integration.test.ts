import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDiagnosis } from "@meguribi/core";
import { ProcessRunner } from "@meguribi/process";
import { createAcpTransport } from "./transport.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function runnableDiagnosis(): AgentDiagnosis {
  return {
    executable: { status: "ok", path: process.execPath },
    version: { status: "supported", raw: "fixture" },
    authentication: { status: "authenticated" },
    acp: { status: "supported" },
    inheritedMcpPolicy: "allow",
    runnable: true,
    warnings: [],
    errors: [],
  };
}

function assertRunnable(diagnosis: AgentDiagnosis): void {
  if (!diagnosis.runnable) {
    throw new Error("fixture diagnosis is not runnable");
  }
}

const fakeServerSource = `import readline from "node:readline";

const scenario = process.env.FAKE_ACP_UPDATE_SCENARIO;

function write(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function notify(sessionId, update) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {},
      authMethods: [],
      agentInfo: { name: "meguribi-acp-observation-fixture", version: "0.1.0" },
    });
    return;
  }
  if (method === "session/new") {
    respond(id, { sessionId: "fixture-session" });
    return;
  }
  if (method === "session/prompt") {
    const sessionId = params.sessionId;
    if (scenario === "standard-metadata") {
      notify(sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "mcp",
            description: "Show the status of the MCP servers, or reconnect them.",
            _meta: { diagnosticText: "MCP server disconnected during a previous run" },
          },
        ],
      });
      notify(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "This assistant message only discusses why an MCP server connected message might appear.",
        },
      });
    }
    if (scenario === "mcp-tool") {
      notify(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "fixture-mcp-tool",
        kind: "search",
        status: "pending",
        title: "Search fixture data",
        name: "mcp__fixture__search",
        rawInput: { query: "fixture" },
      });
      notify(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "fixture-mcp-tool",
        status: "completed",
      });
    }
    if (scenario === "mcp-tool-codex") {
      notify(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "fixture-codex-mcp-tool",
        kind: "execute",
        status: "in_progress",
        title: "mcp.fixture.search",
        rawInput: { server: "fixture", tool: "search", arguments: { query: "fixture" } },
      });
      notify(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "fixture-codex-mcp-tool",
        status: "completed",
      });
    }
    if (scenario === "mcp-tool-meta") {
      notify(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "fixture-meta-mcp-tool",
        kind: "execute",
        status: "in_progress",
        title: "Run fixture lookup",
        rawInput: { server: "fixture", tool: "search", arguments: { query: "fixture" } },
        _meta: { is_mcp_tool_call: true },
      });
      notify(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "fixture-meta-mcp-tool",
        status: "completed",
      });
    }
    if (scenario === "mcp-tool-output") {
      notify(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "fixture-command",
        kind: "execute",
        status: "pending",
        title: "Run fixture command",
        name: "shell",
        rawInput: { command: "fixture-command" },
      });
      notify(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "fixture-command",
        status: "completed",
        rawOutput: { output: "connecting MCP stdio server command=fixture" },
      });
    }
    notify(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "fixture completed" },
    });
    respond(id, { stopReason: "end_turn" });
    return;
  }
  if (id !== undefined) {
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
`;

async function tempCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-acp-observation-"));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, "fake-acp-server.mjs"), fakeServerSource, "utf8");
  return dir;
}

async function start(
  scenario:
    | "standard-metadata"
    | "mcp-tool"
    | "mcp-tool-codex"
    | "mcp-tool-meta"
    | "mcp-tool-output",
) {
  const cwd = await tempCwd();
  const transport = createAcpTransport();
  const connection = await transport.start({
    executable: process.execPath,
    executableArgs: [path.join(cwd, "fake-acp-server.mjs")],
    acpArgs: [],
    cwd,
    env: { ...process.env, FAKE_ACP_UPDATE_SCENARIO: scenario },
    startupTimeoutMs: 5_000,
    postTurnLivenessMs: 50,
    diagnosis: runnableDiagnosis(),
    assertRunnable,
    runner: new ProcessRunner(),
    mcpPolicy: { policy: "deny", mode: "non-interactive", explicitAllow: false },
  });
  return connection;
}

async function drainPrompt(connection: Awaited<ReturnType<typeof start>>) {
  const events = [];
  for await (const event of connection.prompt({ content: "fixture prompt" })) {
    events.push(event);
  }
  return events;
}

describe("AcpTransport MCP observation", () => {
  it("does not treat standard metadata or assistant text as an MCP connection", async () => {
    const connection = await start("standard-metadata");
    const events = await drainPrompt(connection);

    expect(
      events.some(
        (event) =>
          event.kind === "session_update" &&
          event.update.sessionUpdate === "available_commands_update",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.kind === "session_update" && event.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "turn_completed", stopReason: "end_turn" });
    expect(connection.mcpSecurityAlert()).toBeUndefined();

    await connection.closeInput();
    await connection.terminate(500);
  });

  it("blocks an explicit MCP tool call even without connection wording in the title", async () => {
    const connection = await start("mcp-tool");

    await expect(drainPrompt(connection)).rejects.toMatchObject({ code: "policy_blocked" });
    expect(connection.mcpSecurityAlert()).toContain("unexpected-mcp-connection");

    await connection.terminate(500).catch(() => undefined);
  });

  it("blocks the Codex ACP MCP tool title shape", async () => {
    const connection = await start("mcp-tool-codex");

    await expect(drainPrompt(connection)).rejects.toMatchObject({ code: "policy_blocked" });
    expect(connection.mcpSecurityAlert()).toContain("unexpected-mcp-connection");

    await connection.terminate(500).catch(() => undefined);
  });

  it("blocks a tool call explicitly marked as MCP in structured metadata", async () => {
    const connection = await start("mcp-tool-meta");

    await expect(drainPrompt(connection)).rejects.toMatchObject({ code: "policy_blocked" });
    expect(connection.mcpSecurityAlert()).toContain("unexpected-mcp-connection");

    await connection.terminate(500).catch(() => undefined);
  });

  it("keeps blocking real MCP connection output from a tool result", async () => {
    const connection = await start("mcp-tool-output");

    await expect(drainPrompt(connection)).rejects.toMatchObject({ code: "policy_blocked" });
    expect(connection.mcpSecurityAlert()).toContain("unexpected-mcp-connection");

    await connection.terminate(500).catch(() => undefined);
  });
});
