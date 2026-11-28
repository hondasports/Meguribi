import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunState, WorkflowEvent } from "@meguribi/core";
import { FileSystemRunStore } from "./filesystem-run-store.js";
import { FileSystemWorkflowEventLog } from "./workflow-event-log.js";

const temps: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-event-log-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function messageEvent(text: string, at = "2026-11-27T12:00:00.000Z"): WorkflowEvent {
  return {
    type: "agent.event",
    stepId: "implement",
    profileId: "devin",
    agentLabel: "Devin",
    role: "implementer",
    event: { type: "message.delta", sessionId: "session-1", text, at },
  };
}

async function createRun(): Promise<{ store: FileSystemRunStore; state: RunState }> {
  const root = await tempRoot();
  const store = new FileSystemRunStore({
    rootDir: root,
    now: () => new Date("2026-11-27T12:00:00.000Z"),
    randomId: () => "abc123",
  });
  const state = await store.create({
    repository: "owner/repo",
    issueNumber: 76,
    command: "run",
    maxFixAttempts: 2,
    identity: {
      repository: "owner/repo",
      issueNumber: 76,
      branch: "meguribi/issue-76",
      worktreePath: "/tmp/worktree",
      baseRef: "origin/main",
      baseSha: "base",
      headSha: "head",
      remoteIdentity: "github.com/owner/repo",
    },
  });
  return { store, state };
}

describe("FileSystemWorkflowEventLog", () => {
  it("appends records and reads them with a line cursor", async () => {
    const { store, state } = await createRun();
    const log = new FileSystemWorkflowEventLog({ runStore: store });
    await log.append(state.runId, messageEvent("first"), "2026-11-27T12:00:01.000Z");
    await log.append(state.runId, messageEvent("second"), "2026-11-27T12:00:02.000Z");

    const all = await log.read(state.runId);
    expect(all.records.map((record) => record.at)).toEqual([
      "2026-11-27T12:00:01.000Z",
      "2026-11-27T12:00:02.000Z",
    ]);
    expect(all.nextLine).toBe(2);
    expect(all.skippedLines).toBe(0);

    const tail = await log.read(state.runId, 1);
    expect(tail.records).toHaveLength(1);
    expect(tail.records[0]?.at).toBe("2026-11-27T12:00:02.000Z");
    expect(tail.nextLine).toBe(2);
  });

  it("does not return or consume an incomplete final line", async () => {
    const { store, state } = await createRun();
    const log = new FileSystemWorkflowEventLog({ runStore: store });
    await log.append(state.runId, messageEvent("complete"), "2026-11-27T12:00:01.000Z");
    const runDirectory = await store.runDirectory(state.runId);
    expect(runDirectory).not.toBeNull();
    await fs.appendFile(
      path.join(runDirectory!, "events.jsonl"),
      '{"at":"2026-11-27T12:00:02.000Z","event":',
      "utf8",
    );

    const result = await log.read(state.runId);
    expect(result.records).toHaveLength(1);
    expect(result.nextLine).toBe(1);
    expect(result.skippedLines).toBe(0);

    const fromCursor = await log.read(state.runId, result.nextLine);
    expect(fromCursor.records).toEqual([]);
    expect(fromCursor.nextLine).toBe(1);
  });

  it("skips malformed JSON lines and keeps later complete records", async () => {
    const { store, state } = await createRun();
    const runDirectory = await store.runDirectory(state.runId);
    const validLine = `${JSON.stringify({
      at: "2026-11-27T12:00:02.000Z",
      event: messageEvent("valid"),
    })}\n`;
    await fs.writeFile(path.join(runDirectory!, "events.jsonl"), `not-json\n${validLine}`, "utf8");
    const log = new FileSystemWorkflowEventLog({ runStore: store });

    const result = await log.read(state.runId);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.at).toBe("2026-11-27T12:00:02.000Z");
    expect(result.nextLine).toBe(2);
    expect(result.skippedLines).toBe(1);
  });

  it("redacts secret-like text before writing events", async () => {
    const { store, state } = await createRun();
    const log = new FileSystemWorkflowEventLog({ runStore: store });
    await log.append(state.runId, messageEvent("show token=abc123"), "2026-11-27T12:00:01.000Z");

    const result = await log.read(state.runId);
    const serialized = JSON.stringify(result.records[0]);
    expect(serialized).not.toContain("abc123");
    expect(serialized).toContain("[REDACTED]");
  });

  it("uses the injected clock when append omits at", async () => {
    const { store, state } = await createRun();
    const log = new FileSystemWorkflowEventLog({
      runStore: store,
      now: () => new Date("2026-11-27T12:34:56.000Z"),
    });
    await log.append(state.runId, messageEvent("clock"));

    const result = await log.read(state.runId);
    expect(result.records[0]?.at).toBe("2026-11-27T12:34:56.000Z");
  });

  it("returns an empty cursor when events.jsonl does not exist", async () => {
    const { store, state } = await createRun();
    const log = new FileSystemWorkflowEventLog({ runStore: store });
    await expect(log.read(state.runId)).resolves.toEqual({
      records: [],
      nextLine: 0,
      skippedLines: 0,
    });
  });

  it("rejects append for an unknown run", async () => {
    const { store } = await createRun();
    const log = new FileSystemWorkflowEventLog({ runStore: store });
    await expect(log.append("missing-run", messageEvent("x"))).rejects.toThrow(
      "Run not found: missing-run",
    );
  });
});
