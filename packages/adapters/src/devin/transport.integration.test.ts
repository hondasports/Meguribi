import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { DevinDiagnosis } from "@meguribi/core";
import { ProcessRunner } from "@meguribi/process";
import { createDevinAcpTransport } from "./transport.js";
import { DevinAcpTransportError } from "./transport-error.js";

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

function blockedDiagnosis(): DevinDiagnosis {
  return {
    ...runnableDiagnosis(),
    runnable: false,
    errors: [{ code: "unauthenticated", message: "not authenticated" }],
  };
}

async function tempCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-devin-acp-"));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, "README.md"), "# fixture\n", "utf8");
  return dir;
}

async function start(mode: string, overrides: { startupTimeoutMs?: number; diagnosis?: DevinDiagnosis } = {}) {
  const cwd = await tempCwd();
  const transport = createDevinAcpTransport();
  const connection = await transport.start({
    executable: node(),
    executableArgs: [fakeAcpServer()],
    acpArgs: [],
    cwd,
    env: { ...process.env, FAKE_ACP_MODE: mode },
    startupTimeoutMs: overrides.startupTimeoutMs ?? 5_000,
    diagnosis: overrides.diagnosis ?? runnableDiagnosis(),
    runner: new ProcessRunner(),
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

describe("DevinAcpTransport integration", () => {
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
    const transport = createDevinAcpTransport();
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
      }),
    ).rejects.toMatchObject({ code: "not_runnable" });
  });

  it("classifies capability mismatch", async () => {
    await expect(start("capability-mismatch")).rejects.toBeInstanceOf(DevinAcpTransportError);
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
      code: expect.stringMatching(/malformed_message|process_crashed|initialize_failure/),
    });
  });

  it("surfaces connection close during prompt", async () => {
    const { connection } = await start("connection-close-mid-prompt");
    await expect(drainPrompt(connection)).rejects.toBeInstanceOf(DevinAcpTransportError);
    await connection.terminate(500).catch(() => undefined);
  });

  it("emits permission_request events and continues after auto-deny", async () => {
    const { connection } = await start("permission");
    const events = await drainPrompt(connection);
    expect(events.some((event) => event.kind === "permission_request")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "turn_completed" });
    await connection.terminate(500);
  });

  it("does not treat crash-after-prompt-response as turn.completed", async () => {
    const { connection } = await start("crash-mid-prompt");
    await expect(drainPrompt(connection)).rejects.toMatchObject({
      code: "process_crashed",
    });
    await connection.terminate(500).catch(() => undefined);
  });

  it("rejects missing executable without leaving unhandled rejections", async () => {
    const transport = createDevinAcpTransport();
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
          executable: path.join(cwd, "definitely-missing-devin-binary"),
          acpArgs: ["acp"],
          cwd,
          env: { ...process.env },
          startupTimeoutMs: 3_000,
          diagnosis: runnableDiagnosis(),
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
