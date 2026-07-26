import fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { fileURLToPath } from "node:url";

const mode = process.env.FAKE_ACP_MODE ?? "success";
let cancelled = false;
let mcpChild: ChildProcess | undefined;

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForMarker(marker: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(marker);
      return;
    } catch {
      await wait(50);
    }
  }
}

async function startFakeMcp(): Promise<void> {
  const mcpMode = mode === "mcp-http" ? "http" : "stdio";
  process.stderr.write(`Connecting to MCP server fake-${mcpMode} (${mcpMode}${mcpMode === "http" ? ` ${process.env.FAKE_MCP_HTTP_URL ?? ""}` : ""})\n`);
  await wait(500);
  if (cancelled) return;
  if (mcpMode === "stdio") {
    const launcher = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const script = fileURLToPath(new URL("./fake-mcp.ts", import.meta.url));
    mcpChild = spawn(process.execPath, [launcher, script], {
      env: {
        ...process.env,
        FAKE_MCP_MARKER: process.env.FAKE_MCP_MARKER,
        FAKE_MCP_NAME: "fake-stdio"
      },
      shell: false,
      windowsHide: true,
      stdio: "ignore"
    });
    await wait(200);
    if (process.env.FAKE_MCP_MARKER) {
      await waitForMarker(process.env.FAKE_MCP_MARKER, 3_000);
    }
  }
  if (mcpMode === "http" && process.env.FAKE_MCP_HTTP_URL) {
    await fetch(process.env.FAKE_MCP_HTTP_URL, { method: "POST", body: "{}" });
  }
}

async function stopFakeMcp(): Promise<void> {
  if (!mcpChild || mcpChild.exitCode !== null) return;
  mcpChild.kill("SIGTERM");
  await new Promise<void>((resolve) => mcpChild?.once("exit", () => resolve()));
}

if (mode === "malformed") {
  process.stdout.write("not-json\n");
  process.exit(0);
}

const connection = new acp.AgentSideConnection((client) => ({
  initialize: (params) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: { loadSession: false },
    authMethods: [],
    agentInfo: { name: "meguribi-fake-devin", version: "0.1.0" }
  }),
  authenticate: async () => undefined,
  newSession: async (params) => {
    if (mode === "mcp-preprompt") {
      process.stderr.write("Connecting to MCP server fake-preprompt (stdio)\n");
    }
    return { sessionId: `fake-${path.basename(params.cwd)}` };
  },
  prompt: async (params) => {
    try {
      if (mode === "crash") {
        setImmediate(() => process.exit(23));
        await new Promise<never>(() => undefined);
      }
      if (mode === "mcp-stdio" || mode === "mcp-http") {
        await startFakeMcp();
        if (cancelled) return { stopReason: "cancelled" };
      }
    if (mode === "forbidden") {
      await client.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "forbidden-git",
          kind: "execute",
          status: "pending",
          title: "git push",
          content: []
        },
        options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow" }]
      });
      return { stopReason: "end_turn" };
    }
    if (mode === "timeout" || mode === "cancel") {
      while (!cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { stopReason: "cancelled" };
    }

    await client.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake ACP connected" } }
    });
    const readmePath = path.join(process.cwd(), "README.md");
    const permission = await client.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "fake-edit",
        kind: "edit",
        status: "pending",
        title: "Edit README.md",
        locations: [{ path: readmePath }],
        content: []
      },
      options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow" }]
    });
    if (permission.outcome.outcome === "selected") {
      const current = await fs.readFile(readmePath, "utf8");
      await fs.writeFile(readmePath, `${current.trimEnd()}\n\nACP fixture change\n`, "utf8");
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "fake-edit",
          kind: "edit",
          status: "completed",
          title: "Edit README.md"
        }
      });
    }
    await client.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake ACP completed" } }
    });
    return { stopReason: "end_turn" };
    } finally {
      await stopFakeMcp();
    }
  },
  cancel: async () => {
    cancelled = true;
  }
}), acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>
));

void connection;
