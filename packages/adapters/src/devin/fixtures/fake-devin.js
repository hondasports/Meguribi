#!/usr/bin/env node
/**
 * Fake Devin CLI for diagnosis integration tests.
 * Controlled via FAKE_DEVIN_MODE. Does not start ACP sessions or network I/O.
 */
const mode = process.env.FAKE_DEVIN_MODE ?? "ok";
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

if (mode === "timeout") {
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

if (mode === "version-flood" || mode === "flood-output") {
  // 大量出力を flush してから自然終了させ、pipe の未送信データを捨てない。
  process.exitCode = 0;
} else {
  write(process.stderr, `unexpected args: ${args.join(" ")}\n`);
  process.exit(1);
}
