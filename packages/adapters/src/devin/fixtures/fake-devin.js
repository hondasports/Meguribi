#!/usr/bin/env node
/**
 * Scriptable fake Devin CLI for diagnosis and process-boundary integration tests.
 *
 * The public test contract is MEGURIBI_FAKE_DEVIN_SCENARIO. The older
 * FAKE_DEVIN_MODE and FAKE_ACP_MODE variables remain supported by the existing
 * component tests.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const requestedScenario = process.env.MEGURIBI_FAKE_DEVIN_SCENARIO;
const scenarioToProbeMode = {
  success: "ok",
  "write-in-scope": "ok",
  "write-untracked": "ok",
  "write-protected": "ok",
  "write-outside": "ok",
  "symlink-escape": "ok",
  "diff-limit": "ok",
  "reported-files-mismatch": "ok",
  "commit-created": "ok",
  "branch-changed": "ok",
  "secret-in-events": "ok",
  "permission-denied": "ok",
  "permission-timeout": "ok",
  "mcp-detected": "ok",
  "mcp-http-detected": "ok",
  "unsupported-version": "version-unsupported",
  "malformed-version": "version-unknown",
  unauthenticated: "auth-unauthenticated",
  "acp-missing": "no-acp",
  "preflight-timeout": "timeout",
  "version-exit-error": "version-exit-error",
  "malformed-ndjson": "ok",
  "capability-mismatch": "ok",
  "session-fail": "ok",
  cancel: "ok",
  timeout: "ok",
  "sigterm-ignore": "ok",
  "process-tree": "ok",
};
const mode = requestedScenario
  ? scenarioToProbeMode[requestedScenario] ?? requestedScenario
  : process.env.FAKE_DEVIN_MODE ?? "ok";
const args = process.argv.slice(2);

function write(stream, text) {
  stream.write(text);
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait for deterministic timeout tests without extra deps
  }
}

if (mode === "missing") {
  process.exit(127);
}

if (mode === "timeout" && args[0] !== "acp") {
  sleep(60_000);
  process.exit(0);
}

if (args[0] === "--version") {
  if (mode === "version-unknown") {
    write(process.stdout, "devin build-from-source\n");
    process.exit(0);
  }
  if (mode === "version-unsupported") {
    write(process.stdout, "devin 1.0.0\n");
    process.exit(0);
  }
  if (mode === "version-secret") {
    write(
      process.stdout,
      "devin 3000.2.17 token=supersecrettoken123 credential=abc authorization=BearerX client_secret=cs_123 access_token=at_456 DEVIN_CLIENT_SECRET=dcs_789 MY_ACCESS_TOKEN=mat_012 https://mcp.example.com/sse\n",
    );
    process.exit(0);
  }
  if (mode === "version-exit-error") {
    write(process.stdout, "devin 3000.2.17\n");
    process.exit(1);
  }
  if (mode === "version-flood") {
    // 上限 (256KiB) を超える有限出力。無限ループだと Linux で terminate が
    // force_failed になりやすく、診断のサイズ上限検証にも不要。
    const chunk = "A".repeat(8 * 1024);
    process.stdout.write(chunk.repeat(40));
    process.exitCode = 0;
  }
  if (mode !== "version-flood") {
    write(process.stdout, "devin 3000.2.17\n");
    process.exit(0);
  }
}

if (args[0] === "--help") {
  if (mode === "no-acp") {
    write(process.stdout, "Usage: devin <command>\n\nCommands:\n  auth\n  version\n");
    process.exit(0);
  }
  write(
    process.stdout,
    "Usage: devin <command>\n\nCommands:\n  acp    Start ACP stdio server\n  auth\n  version\n",
  );
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  if (mode === "auth-unauthenticated") {
    write(process.stdout, "Status: unauthenticated\n");
    process.exit(1);
  }
  if (mode === "auth-unknown") {
    write(process.stdout, "Status: weird-state\n");
    process.exit(0);
  }
  if (mode === "auth-error") {
    write(process.stderr, "auth status failed: token=leakedsecretvalue\n");
    process.exit(2);
  }
  if (mode === "auth-secret") {
    write(process.stdout, "Status: authenticated\nLogged in as user@example.com\nBearer abc.def.ghi\n");
    process.exit(0);
  }
  write(process.stdout, "Status: authenticated\n");
  process.exit(0);
}

if (args[0] === "acp" && args[1] === "--help") {
  if (mode === "no-acp") {
    write(process.stderr, "Error: unknown command 'acp'\n");
    process.exit(1);
  }
  if (mode === "acp-help-changed") {
    write(process.stdout, "acp — agent client protocol over stdio\nOptions:\n  --cwd <path>\n");
    process.exit(0);
  }
  if (mode === "acp-signal") {
    // help を出したあとに signal 終了させる（exitCode === null 相当）
    write(
      process.stdout,
      "Usage: devin acp\n\nStart an ACP stdio session for agent clients.\n",
    );
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      process.exit(1);
    }
    sleep(5_000);
    process.exit(1);
  }
  if (mode === "flood-output") {
    const chunk = "A".repeat(8 * 1024);
    process.stdout.write(chunk.repeat(40));
    process.exitCode = 0;
  }
  if (mode !== "flood-output") {
    write(
      process.stdout,
      "Usage: devin acp\n\nStart an ACP stdio session for agent clients.\n",
    );
    process.exit(0);
  }
}

if (args[0] === "acp") {
  const acpServer = fileURLToPath(new URL("./fake-acp-server.js", import.meta.url));
  const scenarioToAcpMode = {
    success: "write-in-scope",
    "write-in-scope": "write-in-scope",
    "write-untracked": "write-untracked",
    "write-protected": "write-protected",
    "write-outside": "write-outside",
    "symlink-escape": "symlink-escape",
    "diff-limit": "diff-limit",
    "reported-files-mismatch": "reported-files-mismatch",
    "commit-created": "commit-created",
    "branch-changed": "branch-changed",
    "secret-in-events": "secret-in-message",
    "permission-denied": "permission-denied",
    "permission-timeout": "permission-timeout",
    "mcp-detected": "mcp-stderr",
    "mcp-http-detected": "mcp-http-stderr",
    "malformed-ndjson": "malformed",
    "capability-mismatch": "capability-mismatch",
    "session-fail": "session-fail",
    cancel: "prompt-hang",
    timeout: "prompt-hang",
    "sigterm-ignore": "ignore-sigterm",
    "process-tree": "spawn-grandchildren",
  };
  const acpMode = requestedScenario
    ? scenarioToAcpMode[requestedScenario] ?? requestedScenario
    : process.env.FAKE_ACP_MODE ?? "success";
  const child = spawn(process.execPath, [acpServer], {
    cwd: process.cwd(),
    env: { ...process.env, FAKE_ACP_MODE: acpMode },
    stdio: "inherit",
    windowsHide: true,
  });
  let stopping = false;
  const forwardSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  };
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  child.once("error", () => process.exit(1));
  child.once("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

if (args[0] !== "acp" && (mode === "version-flood" || mode === "flood-output")) {
  // 大量出力を flush してから自然終了させ、pipe の未送信データを捨てない。
  process.exitCode = 0;
} else if (args[0] !== "acp") {
  write(process.stderr, `unexpected args: ${args.join(" ")}\n`);
  process.exit(1);
}
