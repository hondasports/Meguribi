import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DevinAgentArtifactStore, DevinArtifactWriteError } from "./artifact-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-devin-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

describe("DevinAgentArtifactStore", () => {
  it("writes redacted raw and normalized JSONL with shared sequence", async () => {
    const root = await tempRoot();
    const store = new DevinAgentArtifactStore(root);
    await store.init();
    const sequence = store.nextSequence();
    await store.appendRaw(
      "session_update",
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "token=supersecrettoken123" },
      },
      sequence,
      "2026-07-26T00:00:00.000Z",
    );
    await store.appendEvent(
      {
        type: "message.delta",
        sessionId: "s-1",
        text: "token=supersecrettoken123",
        at: "2026-07-26T00:00:00.000Z",
      },
      sequence,
      "2026-07-26T00:00:00.000Z",
    );

    const rawLine = (await fs.readFile(store.rawEventsPath, "utf8")).trim();
    const eventLine = (await fs.readFile(store.eventsPath, "utf8")).trim();
    const raw = JSON.parse(rawLine) as {
      sequence: number;
      raw: { content: { text: string } };
    };
    const event = JSON.parse(eventLine) as {
      sequence: number;
      event: { text: string };
    };

    expect(raw.sequence).toBe(1);
    expect(event.sequence).toBe(1);
    expect(raw.raw.content.text).toContain("[REDACTED]");
    expect(event.event.text).toContain("[REDACTED]");
    expect(rawLine.includes("supersecrettoken123")).toBe(false);
    expect(eventLine.includes("supersecrettoken123")).toBe(false);
  });

  it("round-trips session metadata and result.json", async () => {
    const root = await tempRoot();
    const store = new DevinAgentArtifactStore(root);
    await store.writeSession({
      sessionId: "s-1",
      cwd: "/tmp/work",
      protocolVersion: 1,
      startedAt: "2026-07-26T00:00:00.000Z",
      stopReason: "end_turn",
      finishedAt: "2026-07-26T00:00:01.000Z",
    });
    await store.writeResult({
      status: "completed",
      sessionId: "s-1",
      stopReason: "end_turn",
    });

    const session = JSON.parse(await fs.readFile(store.sessionPath, "utf8")) as {
      sessionId: string;
      stopReason: string;
    };
    const result = JSON.parse(await fs.readFile(store.resultPath, "utf8")) as {
      status: string;
    };
    expect(session.sessionId).toBe("s-1");
    expect(session.stopReason).toBe("end_turn");
    expect(result.status).toBe("completed");
  });

  it("fails closed when append target is not writable", async () => {
    const root = await tempRoot();
    const store = new DevinAgentArtifactStore(root);
    await store.init();
    // Replace events.jsonl with a directory to force append failure.
    await fs.rm(store.eventsPath);
    await fs.mkdir(store.eventsPath);
    await expect(
      store.appendEvent(
        {
          type: "session.started",
          sessionId: "s-1",
          at: "2026-07-26T00:00:00.000Z",
        },
        1,
      ),
    ).rejects.toBeInstanceOf(DevinArtifactWriteError);
  });

  it("preserves existing artifacts and restores sequence on re-init", async () => {
    const root = await tempRoot();
    const first = new DevinAgentArtifactStore(root);
    await first.init();
    await first.appendRaw("session_update", { hello: "world" }, first.nextSequence());
    await first.appendEvent(
      {
        type: "session.started",
        sessionId: "s-1",
        at: "2026-07-26T00:00:00.000Z",
      },
      1,
    );

    const beforeRaw = await fs.readFile(path.join(root, "raw-events.jsonl"), "utf8");
    const beforeEvents = await fs.readFile(path.join(root, "events.jsonl"), "utf8");
    expect(beforeRaw.trim().length).toBeGreaterThan(0);
    expect(beforeEvents.trim().length).toBeGreaterThan(0);

    const resumed = new DevinAgentArtifactStore(root);
    await resumed.init();
    expect(resumed.nextSequence()).toBe(2);

    const afterRaw = await fs.readFile(path.join(root, "raw-events.jsonl"), "utf8");
    const afterEvents = await fs.readFile(path.join(root, "events.jsonl"), "utf8");
    expect(afterRaw).toBe(beforeRaw);
    expect(afterEvents).toBe(beforeEvents);

    await resumed.appendRaw("turn_completed", { stopReason: "end_turn" }, 2);
    const lines = (await fs.readFile(path.join(root, "raw-events.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
  });

  it("redacts structured env secret values by key name", async () => {
    const root = await tempRoot();
    const store = new DevinAgentArtifactStore(root);
    await store.appendRaw(
      "session_update",
      { env: { API_TOKEN: "plain-secret-value", NODE_ENV: "test" } },
      1,
    );
    const line = (await fs.readFile(store.rawEventsPath, "utf8")).trim();
    expect(line.includes("plain-secret-value")).toBe(false);
    const parsed = JSON.parse(line) as {
      raw: { env: { API_TOKEN: string; NODE_ENV: string } };
    };
    expect(parsed.raw.env.API_TOKEN).toBe("[REDACTED]");
    expect(parsed.raw.env.NODE_ENV).toBe("test");
  });
});
