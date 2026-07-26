import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, DevinDiagnosis } from "@meguribi/core";
import { ProcessRunner } from "@meguribi/process";
import { startDevinAcpSession } from "./session.js";

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

async function tempPair(): Promise<{ cwd: string; artifactRoot: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-devin-session-cwd-"));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-devin-session-art-"));
  tempDirs.push(cwd, artifactRoot);
  await fs.writeFile(path.join(cwd, "README.md"), "# fixture\n", "utf8");
  return { cwd, artifactRoot };
}

async function collectEvents(
  mode: string,
): Promise<{ events: AgentEvent[]; artifactRoot: string; sessionId: string }> {
  const { cwd, artifactRoot } = await tempPair();
  const session = await startDevinAcpSession({
    executable: node(),
    executableArgs: [fakeAcpServer()],
    acpArgs: [],
    cwd,
    env: { ...process.env, FAKE_ACP_MODE: mode },
    startupTimeoutMs: 5_000,
    diagnosis: runnableDiagnosis(),
    runner: new ProcessRunner(),
    artifactRoot,
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
  await session.closeInput();
  await session.terminate(500);
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
    expect(events.some((event) => event.type === "approval.required")).toBe(true);
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
    await session.terminate(500).catch(() => undefined);
  });
});
