import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDiagnosis } from "@meguribi/core";
import { ProcessRunner } from "@meguribi/process";
import { createCursorAcpTransport } from "./transport.js";
import { AcpTransportError as CursorAcpTransportError } from "../acp/transport-error.js";
import { createPermissionMediator, type PermissionMediator } from "../acp/permissions.js";
import { assertCursorRunnable } from "./diagnose.js";

const tempDirs: string[] = [];

afterEach(async () => {
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

function blockedDiagnosis(): AgentDiagnosis {
  return {
    ...runnableDiagnosis(),
    runnable: false,
    errors: [{ code: "unauthenticated", message: "not authenticated" }],
  };
}

async function tempCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-cursor-acp-"));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, "README.md"), "# fixture\n", "utf8");
  return dir;
}

async function start(mode: string, overrides: {
  startupTimeoutMs?: number;
  diagnosis?: AgentDiagnosis;
  postTurnLivenessMs?: number;
  promptTimeoutMs?: number;
  permissionMediator?: PermissionMediator;
  mcpPolicy?: { policy: "allow" | "warn" | "deny"; mode: "interactive" | "non-interactive"; explicitAllow: boolean };
} = {}) {
  const cwd = await tempCwd();
  const transport = createCursorAcpTransport();
  const connection = await transport.start({
    executable: node(),
    executableArgs: [fakeAcpServer()],
    acpArgs: [],
    cwd,
    env: { ...process.env, FAKE_ACP_MODE: mode },
    startupTimeoutMs: overrides.startupTimeoutMs ?? 5_000,
    // Keep happy-path tests fast; crash tests override this upward.
    postTurnLivenessMs: overrides.postTurnLivenessMs ?? 50,
    promptTimeoutMs: overrides.promptTimeoutMs,
    diagnosis: overrides.diagnosis ?? runnableDiagnosis(),
    assertRunnable: assertCursorRunnable,
    runner: new ProcessRunner(),
    permissionMediator: overrides.permissionMediator,
    mcpPolicy: overrides.mcpPolicy,
  });
  return { connection, cwd };
}

async function drainPrompt(connection: Awaited<ReturnType<typeof start>>["connection"]) {
  const events = [];
  for await (const event of connection.prompt({ content: "implement fixture" })) {
    events.push(event);
  }
  return events;
}

describe("CursorAcpTransport integration", () => {
  it("initializes, creates a session, and streams prompt updates", async () => {
    const { connection, cwd } = await start("success");
    expect(connection.sessionId).toBe(`fake-${path.basename(cwd)}`);
    expect(connection.protocolVersion).toBeGreaterThanOrEqual(1);

    const events = await drainPrompt(connection);
    expect(events.some((event) => event.kind === "session_update")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: "turn_completed",
      stopReason: "end_turn",
    });

    await connection.closeInput();
    await connection.terminate(500);
  });

  it("records cwd on stderr from the fake server", async () => {
    const { connection, cwd } = await start("stderr-noise");
    await drainPrompt(connection);
    expect(connection.stderrText()).toContain(`cwd=${cwd}`);
    expect(connection.stderrText()).toContain("FAKE_ACP stderr diagnostic line");
    await connection.terminate(500);
  });

  it("refuses to start when diagnosis is not runnable", async () => {
    const transport = createCursorAcpTransport();
    const cwd = await tempCwd();
    await expect(
      transport.start({
        executable: node(),
        executableArgs: [fakeAcpServer()],
        acpArgs: [],
        cwd,
        env: { ...process.env, FAKE_ACP_MODE: "success" },
        startupTimeoutMs: 3_000,
        diagnosis: blockedDiagnosis(),
        assertRunnable: assertCursorRunnable,
      }),
    ).rejects.toMatchObject({ code: "not_runnable" });
  });

  it("classifies capability mismatch", async () => {
    await expect(start("capability-mismatch")).rejects.toBeInstanceOf(CursorAcpTransportError);
    await expect(start("capability-mismatch")).rejects.toMatchObject({
      code: "capability_mismatch",
    });
  });

  it("classifies session creation failure", async () => {
    await expect(start("session-fail")).rejects.toMatchObject({
      code: "session_creation_failure",
    });
  });

  it("times out when initialize never answers", async () => {
    await expect(start("startup-hang", { startupTimeoutMs: 400 })).rejects.toMatchObject({
      code: "startup_timeout",
    });
  });

  it("classifies process crash before initialize", async () => {
    await expect(start("crash-before-init")).rejects.toMatchObject({
      code: expect.stringMatching(/process_crashed|initialize_failure|connection_closed/),
    });
  });

  it("classifies malformed NDJSON during startup", async () => {
    await expect(start("malformed")).rejects.toMatchObject({
      code: expect.stringMatching(
        /malformed_message|process_crashed|initialize_failure|connection_closed/,
      ),
    });
  });

  it("surfaces connection close during prompt as connection_closed", async () => {
    const { connection } = await start("connection-close-mid-prompt");
    await expect(drainPrompt(connection)).rejects.toMatchObject({
      code: "connection_closed",
    });
    await connection.terminate(500).catch(() => undefined);
  });

  it("emits permission_request events and continues after auto-deny", async () => {
    const { connection } = await start("permission");
    const events = await drainPrompt(connection);
    expect(events.some((event) => event.kind === "permission_request")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "turn_completed" });
    await connection.terminate(500);
  });

  it("mediates an ACP permission through the domain policy", async () => {
    const mediator = createPermissionMediator({ mode: "interactive", allowedCommands: [] });
    const { connection } = await start("permission", { permissionMediator: mediator });
    const events = await drainPrompt(connection);
    const permission = events.find((event) => event.kind === "permission_request");
    expect(permission).toMatchObject({ decision: { outcome: "approve" } });
    expect(mediator.records()).toHaveLength(1);
    await connection.terminate(500);
  });

  it("does not treat crash-after-prompt-response as turn.completed", async () => {
    const { connection } = await start("crash-mid-prompt", { postTurnLivenessMs: 300 });
    await expect(drainPrompt(connection)).rejects.toMatchObject({
      code: "process_crashed",
    });
    await connection.terminate(500).catch(() => undefined);
  });

  it("does not treat delayed post-prompt crash as turn.completed", async () => {
    const { connection } = await start("crash-delayed-after-prompt", {
      postTurnLivenessMs: 500,
    });
    await expect(drainPrompt(connection)).rejects.toMatchObject({
      code: "process_crashed",
    });
    await connection.terminate(500).catch(() => undefined);
  });

  it("blocks a detected MCP connection and exposes a redacted security alert", async () => {
    const { connection } = await start("mcp-stderr", {
      mcpPolicy: { policy: "deny", mode: "non-interactive", explicitAllow: false },
    });
    await expect(async () => {
      for await (const _event of connection.prompt({ content: "implement fixture" })) {
        // drain until policy termination
      }
    }).rejects.toMatchObject({ code: "policy_blocked" });
    expect(connection.mcpSecurityAlert()).toContain("SECURITY_ALERT");
    await connection.terminate(500).catch(() => undefined);
  });

  it("detects and redacts an MCP HTTP connection", async () => {
    const { connection } = await start("mcp-http-stderr", {
      mcpPolicy: { policy: "deny", mode: "non-interactive", explicitAllow: false },
    });
    await expect(async () => {
      for await (const _event of connection.prompt({ content: "implement fixture" })) {
        // drain until policy termination
      }
    }).rejects.toMatchObject({ code: "policy_blocked" });
    const alert = connection.mcpSecurityAlert();
    expect(alert).toContain("Transport: http");
    expect(alert).not.toContain("fixture.invalid");
    await connection.terminate(500).catch(() => undefined);
  });

  it("times out a hung ACP turn", async () => {
    const { connection } = await start("prompt-hang", { promptTimeoutMs: 50 });
    await expect(async () => {
      for await (const _event of connection.prompt({ content: "implement fixture" })) {
        // the fake server never completes
      }
    }).rejects.toMatchObject({ code: "turn_timeout" });
    await connection.terminate(500).catch(() => undefined);
  });

  it("rejects missing executable without leaving unhandled rejections", async () => {
    const transport = createCursorAcpTransport();
    const cwd = await tempCwd();
    const previous = process.listenerCount("unhandledRejection");
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        transport.start({
          executable: path.join(cwd, "definitely-missing-cursor-binary"),
          acpArgs: ["acp"],
          cwd,
          env: { ...process.env },
          startupTimeoutMs: 3_000,
          diagnosis: runnableDiagnosis(),
          assertRunnable: assertCursorRunnable,
          runner: new ProcessRunner(),
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/spawn_failure|process_crashed|initialize_failure/),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(seen).toEqual([]);
      expect(process.listenerCount("unhandledRejection")).toBeGreaterThanOrEqual(previous);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
