import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const mode = process.env.FAKE_ACP_MODE ?? "success";
let cancelled = false;

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
  newSession: async (params) => ({ sessionId: `fake-${path.basename(params.cwd)}` }),
  prompt: async (params) => {
    if (mode === "crash") {
      setImmediate(() => process.exit(23));
      await new Promise<never>(() => undefined);
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
  },
  cancel: async () => {
    cancelled = true;
  }
}), acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>
));

void connection;
