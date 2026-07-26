#!/usr/bin/env node
/**
 * Fake Devin ACP stdio server for transport / event integration tests.
 * Controlled via FAKE_ACP_MODE. Does not call real Devin or open network sockets
 * except the intentional mid-prompt close / crash modes.
 *
 * Speaks a minimal ACP JSON-RPC subset over NDJSON on stdin/stdout.
 * stderr is reserved for diagnostic noise.
 *
 * Line handling is event-based so agent→client requests (permission) can be
 * answered while session/prompt is still in flight.
 */
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const mode = process.env.FAKE_ACP_MODE ?? "success";
let cancelled = false;
let nextClientRequestId = 10_000;
const stateFile = process.env.MEGURIBI_FAKE_DEVIN_STATE_FILE;
let releasePromptHang;
/** @type {Map<number | string, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
const pendingClientRequests = new Map();

function writeStdout(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeStderr(text) {
  process.stderr.write(text);
}

function respond(id, result) {
  writeStdout({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  writeStdout({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  writeStdout({ jsonrpc: "2.0", method, params });
}

function requestClient(method, params) {
  const id = nextClientRequestId++;
  writeStdout({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject });
  });
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function markState(value) {
  if (!stateFile) return;
  await fs.writeFile(stateFile, `${value}\n`, "utf8");
}

async function runGit(...args) {
  await execFileAsync("git", args, { cwd: process.cwd(), windowsHide: true });
}

async function writeOutsideWorktree() {
  const target = process.env.MEGURIBI_FAKE_OUTSIDE_PATH ??
    path.resolve(process.cwd(), "..", "meguribi-fake-outside.txt");
  await fs.writeFile(target, "fake outside mutation\n", "utf8");
}

async function createEscapingSymlink() {
  const target = process.env.MEGURIBI_FAKE_OUTSIDE_PATH ??
    path.resolve(process.cwd(), "..", "meguribi-fake-symlink-target.txt");
  const link = path.join(process.cwd(), "escaped-link.txt");
  await fs.writeFile(target, "fake symlink target\n", "utf8");
  await fs.rm(link, { force: true });
  await fs.symlink(target, link);
}

function spawnGrandchildren() {
  const child = fileURLToPath(new URL("../../../../process/src/fixtures/spawn-child.js", import.meta.url));
  return import("node:child_process").then(({ spawn }) => spawn(process.execPath, [child], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  }));
}

if (mode === "crash-before-init") {
  process.exit(17);
}

if (mode === "malformed") {
  process.stdout.write("not-json-at-all\n");
  await wait(200);
  process.exit(0);
}

if (mode === "startup-hang") {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", () => {
    // intentionally ignore
  });
  await new Promise(() => undefined);
}

async function handlePrompt(id, params) {
  const sessionId = params.sessionId ?? "unknown";
  await markState("prompt-started");
  if (mode === "prompt-hang") {
    await new Promise((resolve) => {
      releasePromptHang = resolve;
    });
  }
  if (mode === "permission-timeout") {
    await requestClient("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "fake-perm-timeout",
        kind: "edit",
        status: "pending",
        title: "Edit README.md",
        locations: [{ path: path.join(process.cwd(), "README.md") }],
        content: [],
      },
      options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow" }],
    });
  }
  if (mode === "write-protected") {
    await fs.writeFile(path.join(process.cwd(), ".env.local"), "TOKEN=fixture\n", "utf8");
  }
  if (mode === "write-in-scope") {
    await fs.writeFile(path.join(process.cwd(), "README.md"), "# changed by fixture\n", "utf8");
  }
  if (mode === "write-untracked") {
    await fs.writeFile(path.join(process.cwd(), "untracked.txt"), "created by fixture\n", "utf8");
  }
  if (mode === "write-outside") {
    await writeOutsideWorktree();
  }
  if (mode === "symlink-escape") {
    await createEscapingSymlink();
  }
  if (mode === "diff-limit") {
    await fs.writeFile(
      path.join(process.cwd(), "large-change.txt"),
      "line\n".repeat(2_100),
      "utf8",
    );
  }
  if (mode === "commit-created") {
    await runGit("add", "README.md");
    await runGit("commit", "-m", "fake Devin commit");
  }
  if (mode === "branch-changed") {
    await runGit("switch", "-c", "fake-devin-branch");
  }
  if (mode === "spawn-grandchildren") {
    await spawnGrandchildren();
  }
  if (mode === "crash-mid-prompt") {
    writeStderr("diagnostic before crash\n");
    respond(id, { stopReason: "end_turn" });
    process.exit(23);
  }

  if (mode === "crash-delayed-after-prompt") {
    writeStderr("diagnostic before delayed crash\n");
    respond(id, { stopReason: "end_turn" });
    await wait(250);
    process.exit(27);
  }

  if (mode === "connection-close-mid-prompt") {
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before close" },
      },
    });
    process.stdout.destroy();
    await wait(100);
    process.exit(0);
  }

  if (mode === "stderr-noise") {
    writeStderr("FAKE_ACP stderr diagnostic line\n");
  }

  if (mode === "mcp-stderr") {
    writeStderr("starting MCP stdio server command=fixture\n");
    await wait(20);
  }

  if (mode === "mcp-http-stderr") {
    writeStderr("connecting to MCP http endpoint https://fixture.invalid/sse\n");
    await wait(20);
  }

  if (mode === "permission" || mode === "permission-denied") {
    const permissionPath = mode === "permission-denied"
      ? path.join(process.cwd(), ".env.local")
      : path.join(process.cwd(), "README.md");
    await requestClient("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "fake-perm-1",
        kind: "edit",
        status: "pending",
        title: "Edit README.md",
        locations: [{ path: permissionPath }],
        content: [],
      },
      options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow" }],
    });
  }

  const text =
    mode === "secret-in-message"
      ? "using token=supersecrettoken123 and Bearer abc.def.ghi"
      : "fake ACP connected";

  const reportedPath = mode === "reported-files-mismatch"
    ? "reported-only.ts"
    : "README.md";

  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });

  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "fake-edit",
      kind: "edit",
      title: "Edit README.md",
      name: "edit",
      status: "pending",
      locations: [{ path: reportedPath }],
    },
  });

  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "fake-edit",
      kind: "edit",
      name: "edit",
      status: "completed",
      title: "Edit README.md",
    },
  });

  if (mode === "unknown-update") {
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "internal thought" },
      },
    });
  }

  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "fake ACP completed" },
    },
  });

  if (cancelled) {
    respond(id, { stopReason: "cancelled" });
    return;
  }
  respond(id, { stopReason: "end_turn" });
}

if (mode === "ignore-sigterm") {
  process.on("SIGTERM", () => undefined);
  process.on("SIGINT", () => undefined);
  setInterval(() => undefined, 1_000);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("close", () => {
  if (mode !== "ignore-sigterm" && mode !== "spawn-grandchildren" && mode !== "prompt-hang") {
    process.exit(0);
  }
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeStderr(`invalid json from client: ${line.slice(0, 80)}\n`);
    return;
  }

  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const pending = pendingClientRequests.get(message.id);
    if (pending) {
      pendingClientRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "client error"));
      } else {
        pending.resolve(message.result);
      }
    }
    return;
  }

  const { id, method, params } = message;

  if (method === "session/cancel") {
    cancelled = true;
    releasePromptHang?.();
    return;
  }

  if (method === "initialize") {
    if (mode === "capability-mismatch") {
      respondError(id, -32000, "capability mismatch: required features unavailable");
      return;
    }
    if (mode === "crash-after-init") {
      respond(id, {
        protocolVersion: params.protocolVersion,
        agentCapabilities: { loadSession: false },
        authMethods: [],
        agentInfo: { name: "meguribi-fake-devin", version: "0.1.0" },
      });
      setImmediate(() => process.exit(19));
      return;
    }
    respond(id, {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false },
      authMethods: [],
      agentInfo: { name: "meguribi-fake-devin", version: "0.1.0" },
    });
    return;
  }

  if (method === "session/new") {
    if (mode === "session-fail") {
      respondError(id, -32001, "session creation failed");
      return;
    }
    writeStderr(`cwd=${params.cwd}\n`);
    respond(id, { sessionId: `fake-${path.basename(params.cwd)}` });
    return;
  }

  if (method === "session/prompt") {
    void handlePrompt(id, params ?? {}).catch((error) => {
      respondError(id, -32002, error instanceof Error ? error.message : "prompt failed");
    });
    return;
  }

  if (id !== undefined) {
    respondError(id, -32601, `Method not found: ${method}`);
  }
});
