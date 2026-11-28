import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileSystemDiscussionStore,
  FileSystemRunStore,
  FileSystemWorkflowEventLog,
} from "@meguribi/adapters";
import type {
  DiscussionConclusion,
  DiscussionTurn,
  RunState,
  WorkflowEvent,
  WorkflowEventLog,
  WorkflowEventRecord,
} from "@meguribi/core";
import { createRunStoreApi } from "./run-store-api.js";

const tempDirs: string[] = [];

class CountingWorkflowEventLog implements WorkflowEventLog {
  reads = 0;

  constructor(private readonly inner: FileSystemWorkflowEventLog) {}

  async append(runId: string, event: WorkflowEvent, at?: string): Promise<void> {
    await this.inner.append(runId, event, at);
  }

  async read(runId: string, fromLine = 0): Promise<{
    records: WorkflowEventRecord[];
    nextLine: number;
    skippedLines: number;
  }> {
    this.reads += 1;
    return this.inner.read(runId, fromLine);
  }
}

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-web-runs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFixture() {
  const rootDir = await tempRoot();
  let randomIndex = 0;
  const runStore = new FileSystemRunStore({
    rootDir,
    now: () => new Date("2026-11-28T12:00:00.000Z"),
    randomId: () => `test${String(++randomIndex).padStart(2, "0")}`,
  });
  const realEventLog = new FileSystemWorkflowEventLog({ runStore });
  const eventLog = new CountingWorkflowEventLog(realEventLog);
  return { rootDir, runStore, eventLog };
}

async function createRun(runStore: FileSystemRunStore, issueNumber = 42): Promise<RunState> {
  return runStore.create({
    repository: "owner/repo",
    issueNumber,
    command: "run",
    maxFixAttempts: 1,
    identity: {
      repository: "owner/repo",
      issueNumber,
      branch: `meguribi/issue-${String(issueNumber)}`,
      worktreePath: "/tmp/worktree",
      baseRef: "origin/main",
      baseSha: "base",
      headSha: "head",
      remoteIdentity: "github.com/owner/repo",
    },
  });
}

async function createDiscussionRun(
  runStore: FileSystemRunStore,
  issueNumber = 83,
): Promise<RunState> {
  return runStore.create({
    repository: "owner/repo",
    issueNumber,
    command: "discuss",
    maxFixAttempts: 0,
    identity: {
      repository: "owner/repo",
      issueNumber,
      branch: `meguribi/issue-${String(issueNumber)}`,
      worktreePath: "/tmp/worktree",
      baseRef: "origin/main",
      baseSha: "base",
      headSha: "head",
      remoteIdentity: "github.com/owner/repo",
    },
  });
}

async function createConsultationRun(runStore: FileSystemRunStore): Promise<RunState> {
  return runStore.create({
    repository: "owner/repo",
    command: "consult",
    maxFixAttempts: 0,
    consultation: {
      worktreePath: "/tmp/worktree",
      remoteIdentity: "github.com/owner/repo",
    },
  });
}

function discussionTurn(message = "議論メッセージ"): DiscussionTurn {
  return {
    turnId: "t-1",
    speaker: "codex",
    speakerLabel: "Codex",
    envelope: {
      message,
      replyTo: [],
      addressTo: [],
      positions: [],
      newIssues: [],
      done: true,
    },
    malformed: false,
    at: "2026-11-28T12:00:00.000Z",
  };
}

function discussionConclusion(message = "結論"): DiscussionConclusion {
  return {
    topic: "topic",
    conclusion: message,
    issues: [],
    rejectedOptions: [],
    openQuestions: [],
    acceptanceCriteriaSeeds: [],
    endedBy: "consensus",
    transcriptHash: "hash",
  };
}

function liveStepStarted(profileId = "devin", stepId = "implement"): WorkflowEvent {
  return {
    type: "step.started",
    stepId,
    label: stepId,
    role: "implementer",
    profileId,
    agentLabel: profileId === "devin" ? "Devin" : profileId,
  };
}

function liveMessage(profileId: string, text: string, at: string): WorkflowEvent {
  return {
    type: "agent.event",
    stepId: "implement",
    profileId,
    agentLabel: profileId === "devin" ? "Devin" : profileId,
    role: "implementer",
    event: {
      type: "message.delta",
      sessionId: `${profileId}-session`,
      text,
      at,
    },
  };
}

function liveToolStarted(profileId: string, at: string): WorkflowEvent {
  return {
    type: "agent.event",
    stepId: "implement",
    profileId,
    agentLabel: profileId === "devin" ? "Devin" : profileId,
    role: "implementer",
    event: {
      type: "tool.started",
      sessionId: `${profileId}-session`,
      tool: "Terminal",
      toolCallId: `${profileId}-tool-1`,
      summary: "pnpm test",
      at,
    },
  };
}

async function withApiServer(
  options: Parameters<typeof createRunStoreApi>[0],
  run: (port: number) => Promise<void>,
): Promise<void> {
  const api = createRunStoreApi(options);
  const server = http.createServer((req, res) => {
    api
      .handle(req, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Not found" }));
        }
      })
      .catch((error: unknown) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("test server did not expose a port");
  }
  try {
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function getJson(port: number, requestPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: requestPath }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
  });
}

interface CapturedSseEvent {
  name: string;
  data: string;
}

interface SseClient {
  events: CapturedSseEvent[];
  close: () => void;
  closed: Promise<void>;
}

function connectSse(port: number, requestPath: string): SseClient {
  const events: CapturedSseEvent[] = [];
  let buffer = "";
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const req = http.get({ host: "127.0.0.1", port, path: requestPath }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd >= 0) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const lines = frame.split("\n");
        const name = lines.find((line) => line.startsWith("event: "))?.slice(7);
        const data = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (name) {
          events.push({ name, data });
        }
        frameEnd = buffer.indexOf("\n\n");
      }
    });
    res.on("end", resolveClosed);
    res.on("close", resolveClosed);
  });
  req.on("error", resolveClosed);
  req.on("close", resolveClosed);
  return { events, close: () => req.destroy(), closed };
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function logChunks(client: SseClient): Array<{ pane: string; text: string }> {
  return client.events
    .filter((event) => event.name === "log")
    .map((event) => JSON.parse(event.data) as { pane: string; text: string });
}

describe("run-store api", () => {
  it("lists recent runs as summaries", async () => {
    const { runStore, eventLog } = await createFixture();
    const older = await createRun(runStore, 42);
    const newer = await createRun(runStore, 43);
    await runStore.update(older.runId, {
      status: "awaiting_human",
      updatedAt: "2026-11-28T12:00:01.000Z",
      pullRequestNumber: 101,
    });
    await runStore.update(newer.runId, {
      status: "implementing",
      currentStep: "implementing",
      updatedAt: "2026-11-28T12:00:02.000Z",
    });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, "/api/run-store/runs?limit=2");
      expect(response.status).toBe(200);
      const body = response.body as Array<Record<string, unknown>>;
      expect(body.map((run) => run.runId)).toEqual([newer.runId, older.runId]);
      expect(body[0]).toEqual({
        runId: newer.runId,
        repository: "owner/repo",
        issueNumber: 43,
        command: "run",
        status: "implementing",
        currentStep: "implementing",
        updatedAt: "2026-11-28T12:00:02.000Z",
        pullRequestNumber: null,
      });
      expect(body[1]?.pullRequestNumber).toBe(101);
    });
  });

  it("includes the persisted consultation topic as a summary title", async () => {
    const { runStore, eventLog } = await createFixture();
    const state = await createConsultationRun(runStore);
    await runStore.saveArtifact(state.runId, "consultation-input.json", {
      schemaVersion: 1,
      artifactType: "consultation-input",
      repository: "owner/repo",
      repositoryPath: "/tmp/repo",
      artifactRoot: "/tmp/artifacts",
      topic: "\n通知を減らしたい\n詳細な背景",
      repositoryRules: "",
      limits: { maxTurns: 9, maxDurationMs: 1_800_000, turnTimeoutMs: 300_000 },
    });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, "/api/run-store/runs");
      expect(response.status).toBe(200);
      const body = response.body as Array<Record<string, unknown>>;
      expect(body[0]?.title).toBe("通知を減らしたい");
    });
  });

  it("truncates a long consultation title deterministically", async () => {
    const { runStore, eventLog } = await createFixture();
    const state = await createConsultationRun(runStore);
    await runStore.saveArtifact(state.runId, "consultation-input.json", {
      topic: `${"a".repeat(90)} rest`,
    });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, "/api/run-store/runs");
      const body = response.body as Array<Record<string, unknown>>;
      expect(body[0]?.title).toBe(`${"a".repeat(77)}...`);
    });
  });

  it("uses the issue discussion userRequest as a summary title when present", async () => {
    const { runStore, eventLog } = await createFixture();
    const state = await createDiscussionRun(runStore);
    await runStore.saveArtifact(state.runId, "discussion-input.json", {
      repositoryPath: "/tmp/repo",
      worktreePath: "/tmp/worktree",
      branch: "meguribi/issue-83",
      baseRef: "origin/main",
      requiredLabels: [],
      repositoryRules: "",
      userRequest: "キャッシュ戦略を議論したい",
      limits: { maxTurns: 9, maxDurationMs: 1_800_000, turnTimeoutMs: 300_000 },
      nonInteractive: true,
      artifactRoot: "/tmp/artifacts",
    });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, "/api/run-store/runs");
      const body = response.body as Array<Record<string, unknown>>;
      expect(body[0]?.title).toBe("キャッシュ戦略を議論したい");
    });
  });

  it("omits the title when no persisted prompt exists or the artifact is malformed", async () => {
    const { rootDir, runStore, eventLog } = await createFixture();
    const plain = await createDiscussionRun(runStore, 83);
    const malformed = await createConsultationRun(runStore);
    // 破損したアーティファクトを直接書き込む（読み込み失敗で一覧全体を落としてはいけない）。
    const runDir = path.join(rootDir, "runs", "owner", "repo", "consultations", malformed.runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "consultation-input.json"), "{broken json", "utf8");

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, "/api/run-store/runs");
      expect(response.status).toBe(200);
      const body = response.body as Array<Record<string, unknown>>;
      expect(body).toHaveLength(2);
      expect(body.every((run) => !("title" in run))).toBe(true);
    });
    expect(plain.command).toBe("discuss");
  });

  it("redacts secret-looking content from the summary title before truncating", async () => {
    const { runStore, eventLog } = await createFixture();
    const state = await createConsultationRun(runStore);
    const dummySecret = "sk-dummy1234567890abcdef";
    await runStore.saveArtifact(state.runId, "consultation-input.json", {
      topic: `API 連携の相談 api_key=${dummySecret} について`,
    });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, "/api/run-store/runs");
      expect(response.status).toBe(200);
      const body = response.body as Array<Record<string, unknown>>;
      const title = body[0]?.title;
      expect(typeof title).toBe("string");
      expect(title).not.toContain(dummySecret);
      expect(title).not.toContain("api_key=");
      expect(title).toContain("[REDACTED]");
    });
  });

  it("does not leak a truncated fragment of a long secret token", async () => {
    const { runStore, eventLog } = await createFixture();
    const state = await createConsultationRun(runStore);
    // 先頭に長い秘密値を置く。切り詰めが redact に先行すると、
    // パターンが途中で切れて秘密値の断片がタイトルに残ってしまう。
    const longToken = `sk-${"x".repeat(100)}`;
    await runStore.saveArtifact(state.runId, "consultation-input.json", {
      topic: `${longToken} の取り扱い`,
    });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, "/api/run-store/runs");
      const body = response.body as Array<Record<string, unknown>>;
      const title = body[0]?.title as string;
      expect(title).not.toContain("xxxx");
      expect(title).not.toContain("sk-");
    });
  });

  it("ignores non-string or hostile artifact field values", async () => {
    const { runStore, eventLog } = await createFixture();
    const state = await createConsultationRun(runStore);
    await runStore.saveArtifact(state.runId, "consultation-input.json", {
      topic: { malicious: true },
    });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, "/api/run-store/runs");
      expect(response.status).toBe(200);
      const body = response.body as Array<Record<string, unknown>>;
      expect(body[0] && "title" in body[0]).toBe(false);
    });
  });

  it("returns run detail with delivery pipeline state and agent activities", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createRun(runStore);
    await runStore.update(run.runId, { status: "implementing", currentStep: "implementing" });
    await eventLog.append(run.runId, {
      type: "workflow.started",
      runId: run.runId,
      workflow: "delivery",
      at: "2026-11-28T12:00:00.000Z",
    }, "2026-11-28T12:00:00.000Z");
    await eventLog.append(run.runId, {
      type: "workflow.step.started",
      runId: run.runId,
      stepId: "plan",
      kind: "plan",
      visit: 1,
      at: "2026-11-28T12:00:01.000Z",
    }, "2026-11-28T12:00:01.000Z");
    await eventLog.append(run.runId, {
      type: "workflow.step.completed",
      runId: run.runId,
      stepId: "plan",
      kind: "plan",
      outcome: "continue",
      at: "2026-11-28T12:00:02.000Z",
    }, "2026-11-28T12:00:02.000Z");
    await eventLog.append(run.runId, {
      type: "workflow.step.started",
      runId: run.runId,
      stepId: "implement",
      kind: "implement",
      visit: 1,
      at: "2026-11-28T12:00:03.000Z",
    }, "2026-11-28T12:00:03.000Z");
    await eventLog.append(run.runId, liveToolStarted("devin", "2026-11-28T12:00:04.000Z"), "2026-11-28T12:00:04.000Z");

    await withApiServer({
      runStore,
      eventLog,
      now: () => new Date("2026-11-28T12:00:16.000Z"),
    }, async (port) => {
      const response = await getJson(port, `/api/run-store/runs/${run.runId}`);
      expect(response.status).toBe(200);
      const detail = response.body as {
        state: RunState;
        pipeline: Array<{ stepId: string; kind: string; status: string; visit: number }>;
        activities: Array<{ profileId: string; state: string; detail?: string }>;
      };
      expect(detail.state.runId).toBe(run.runId);
      expect(detail.pipeline.map((step) => [step.stepId, step.status, step.visit])).toEqual([
        ["plan", "completed", 1],
        ["implement", "running", 1],
        ["verify", "pending", 0],
        ["review", "pending", 0],
        ["fix-after-verify", "pending", 0],
        ["fix-after-review", "pending", 0],
        ["publish", "pending", 0],
      ]);
      expect(detail.pipeline[0]?.kind).toBe("plan");
      expect(detail.activities).toHaveLength(1);
      expect(detail.activities[0]).toMatchObject({
        profileId: "devin",
        state: "running_tool",
        detail: "pnpm test",
      });
    });
  });

  it("returns pending pipeline and empty activities when events.jsonl does not exist", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createRun(runStore);

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, `/api/run-store/runs/${run.runId}`);
      expect(response.status).toBe(200);
      const detail = response.body as {
        pipeline: Array<{ status: string; visit: number }>;
        activities: unknown[];
      };
      expect(detail.pipeline).toHaveLength(7);
      expect(detail.pipeline.every((step) => step.status === "pending" && step.visit === 0)).toBe(true);
      expect(detail.activities).toEqual([]);
    });
  });

  it("streams existing and appended logs independently to two clients, then ends", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createRun(runStore);
    await runStore.update(run.runId, { status: "implementing", currentStep: "implementing" });
    await eventLog.append(run.runId, liveStepStarted(), "2026-11-28T12:00:00.000Z");
    await eventLog.append(run.runId, liveMessage("devin", "hello", "2026-11-28T12:00:01.000Z"), "2026-11-28T12:00:01.000Z");

    await withApiServer({ runStore, eventLog, pollMs: 15 }, async (port) => {
      const first = connectSse(port, `/api/run-store/runs/${run.runId}/stream`);
      const second = connectSse(port, `/api/run-store/runs/${run.runId}/stream`);
      await waitFor(
        () => logChunks(first).length >= 2 && logChunks(second).length >= 2,
        "initial live logs on both clients",
      );

      await eventLog.append(run.runId, liveToolStarted("devin", "2026-11-28T12:00:02.000Z"), "2026-11-28T12:00:02.000Z");
      await eventLog.append(run.runId, liveMessage("codex", "reviewing", "2026-11-28T12:00:03.000Z"), "2026-11-28T12:00:03.000Z");
      await runStore.update(run.runId, { status: "awaiting_human" });
      await waitFor(
        () => first.events.some((event) => event.name === "end") && second.events.some((event) => event.name === "end"),
        "end events on both clients",
      );
      await Promise.all([first.closed, second.closed]);

      for (const client of [first, second]) {
        const chunks = logChunks(client);
        const allText = chunks.filter((chunk) => chunk.pane === "all").map((chunk) => chunk.text).join("");
        const devinText = chunks.filter((chunk) => chunk.pane === "devin").map((chunk) => chunk.text).join("");
        const codexText = chunks.filter((chunk) => chunk.pane === "codex").map((chunk) => chunk.text).join("");
        expect(allText).toContain("── implement · Devin (implementer)");
        expect(allText).toContain("● Devin  hello");
        expect(allText).toContain("● Terminal  pnpm test");
        expect(allText).toContain("● codex  reviewing");
        expect(devinText).toContain("● Devin  hello");
        expect(devinText).toContain("● Terminal  pnpm test");
        expect(devinText).not.toContain("reviewing");
        expect(codexText).toContain("● codex  reviewing");
        expect(client.events.some((event) => event.name === "detail")).toBe(true);
      }
    });
  });

  it("closes an already terminal run after replaying existing events", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createRun(runStore);
    await eventLog.append(run.runId, liveMessage("devin", "done", "2026-11-28T12:00:00.000Z"), "2026-11-28T12:00:00.000Z");
    await runStore.update(run.runId, { status: "awaiting_human" });

    await withApiServer({ runStore, eventLog, pollMs: 15 }, async (port) => {
      const client = connectSse(port, `/api/run-store/runs/${run.runId}/stream`);
      await waitFor(() => client.events.some((event) => event.name === "end"), "terminal end event");
      await client.closed;
      expect(logChunks(client).some((chunk) => chunk.pane === "all" && chunk.text.includes("done"))).toBe(true);
    });
  });

  it("stops polling the event log after the client disconnects", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createRun(runStore);
    await runStore.update(run.runId, { status: "implementing", currentStep: "implementing" });

    await withApiServer({ runStore, eventLog, pollMs: 15 }, async (port) => {
      const client = connectSse(port, `/api/run-store/runs/${run.runId}/stream`);
      await waitFor(() => eventLog.reads > 0, "initial event log read");
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const readsAfterDisconnect = eventLog.reads;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(eventLog.reads).toBe(readsAfterDisconnect);
    });
  });

  it("rejects invalid run ids and reports missing runs", async () => {
    const { runStore, eventLog } = await createFixture();

    await withApiServer({ runStore, eventLog }, async (port) => {
      for (const requestPath of [
        "/api/run-store/runs/..",
        "/api/run-store/runs/..%2Fsecret",
        "/api/run-store/runs/bad%5Cid",
        "/api/run-store/runs/..%2Fsecret/stream",
      ]) {
        const response = await getJson(port, requestPath);
        expect(response.status).toBe(400);
      }
      const missing = await getJson(port, "/api/run-store/runs/missing-run");
      expect(missing.status).toBe(404);
    });
  });
  it("returns discussion detail with redacted turns, conclusion, approval, and decision flags", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createDiscussionRun(runStore);
    await runStore.update(run.runId, { status: "awaiting_human" });
    const store = new FileSystemDiscussionStore({ runStore, runId: run.runId });
    await store.appendTurn(discussionTurn("token=abc123456789 を含む発言"));
    await store.saveConclusion(discussionConclusion("承認待ちの結論"));
    await runStore.saveArtifact(run.runId, "approval.json", {
      decision: "rejected",
      approver: "human",
      at: "2026-11-28T12:00:00.000Z",
      conclusionHash: "hash",
      comment: "token=abc123456789 を含む却下",
      redo: true,
    });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, `/api/run-store/runs/${run.runId}/discussion`);
      expect(response.status).toBe(200);
      const detail = response.body as {
        turns: Array<{ envelope: { message: string } }>;
        conclusion: { conclusion: string } | null;
        approval: { decision: string; comment?: string } | null;
        canInterject: boolean;
        canDecide: boolean;
      };
      expect(detail.turns).toHaveLength(1);
      expect(detail.turns[0]?.envelope.message).not.toContain("abc123456789");
      expect(detail.conclusion?.conclusion).toBe("承認待ちの結論");
      expect(detail.approval?.decision).toBe("rejected");
      expect(detail.approval?.comment).not.toContain("abc123456789");
      expect(detail.canInterject).toBe(false);
      expect(detail.canDecide).toBe(true);
    });
  });

  it("returns discussion flags for active and terminal states", async () => {
    const { runStore, eventLog } = await createFixture();
    const active = await createDiscussionRun(runStore, 83);
    const terminal = await createDiscussionRun(runStore, 84);
    await runStore.update(terminal.runId, { status: "completed" });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const activeResponse = await getJson(port, `/api/run-store/runs/${active.runId}/discussion`);
      expect(activeResponse.status).toBe(200);
      expect(
        (activeResponse.body as { canInterject: boolean; canDecide: boolean }).canInterject,
      ).toBe(true);
      expect((activeResponse.body as { canInterject: boolean; canDecide: boolean }).canDecide).toBe(
        false,
      );

      const terminalResponse = await getJson(
        port,
        `/api/run-store/runs/${terminal.runId}/discussion`,
      );
      expect(terminalResponse.status).toBe(200);
      expect((terminalResponse.body as { canInterject: boolean }).canInterject).toBe(false);
    });
  });

  it("includes the masked persisted prompt in consultation detail for history reload", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createConsultationRun(runStore);
    const originalPrompt = "通知を減らしたい\n背景: 毎朝20件来る";
    await runStore.saveArtifact(run.runId, "consultation-input.json", {
      schemaVersion: 1,
      artifactType: "consultation-input",
      repository: "owner/repo",
      repositoryPath: "/tmp/repo",
      artifactRoot: "/tmp/artifacts",
      topic: originalPrompt,
      repositoryRules: "",
      limits: { maxTurns: 9, maxDurationMs: 1_800_000, turnTimeoutMs: 300_000 },
    });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, `/api/run-store/runs/${run.runId}/discussion`);
      expect(response.status).toBe(200);
      const body = response.body as Record<string, unknown>;
      // 履歴再読み込みで復元できるよう、切り詰めない全文を返す。
      expect(body.prompt).toBe(originalPrompt);
    });
  });

  it("uses the persisted userRequest as the prompt for issue-backed discussions", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createDiscussionRun(runStore);
    await runStore.saveArtifact(run.runId, "discussion-input.json", {
      repositoryPath: "/tmp/repo",
      worktreePath: "/tmp/worktree",
      branch: "meguribi/issue-83",
      baseRef: "origin/main",
      requiredLabels: [],
      repositoryRules: "",
      userRequest: "キャッシュ戦略を議論したい",
      limits: { maxTurns: 9, maxDurationMs: 1_800_000, turnTimeoutMs: 300_000 },
      nonInteractive: true,
      artifactRoot: "/tmp/artifacts",
    });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, `/api/run-store/runs/${run.runId}/discussion`);
      const body = response.body as Record<string, unknown>;
      expect(body.prompt).toBe("キャッシュ戦略を議論したい");
    });
  });

  it("masks secret-looking content in the detail prompt", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createConsultationRun(runStore);
    const dummySecret = "sk-dummy1234567890abcdef";
    await runStore.saveArtifact(run.runId, "consultation-input.json", {
      topic: `api_key=${dummySecret} の相談`,
    });

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, `/api/run-store/runs/${run.runId}/discussion`);
      const body = response.body as Record<string, unknown>;
      expect(body.prompt).not.toContain(dummySecret);
      expect(body.prompt).toContain("[REDACTED]");
    });
  });

  it("omits the prompt when no persisted input exists", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createConsultationRun(runStore);

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, `/api/run-store/runs/${run.runId}/discussion`);
      expect(response.status).toBe(200);
      const body = response.body as Record<string, unknown>;
      expect("prompt" in body).toBe(false);
    });
  });

  it("returns 404 for discussion detail of a non-discussion run", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createRun(runStore);

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, `/api/run-store/runs/${run.runId}/discussion`);
      expect(response.status).toBe(404);
    });
  });

  it("streams discussion detail when discussion events arrive", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createDiscussionRun(runStore);
    const store = new FileSystemDiscussionStore({ runStore, runId: run.runId });
    await store.appendTurn(discussionTurn());

    await withApiServer({ runStore, eventLog, pollMs: 15 }, async (port) => {
      const client = connectSse(port, `/api/run-store/runs/${run.runId}/stream`);
      await eventLog.append(
        run.runId,
        {
          type: "discussion.turn",
          runId: run.runId,
          turn: discussionTurn(),
          turnNumber: 1,
          maxTurns: 20,
        },
        "2026-11-28T12:00:00.000Z",
      );
      await waitFor(
        () => client.events.some((event) => event.name === "discussion"),
        "discussion SSE event",
      );
      client.close();
      const event = client.events.find((candidate) => candidate.name === "discussion");
      const detail = JSON.parse(event?.data ?? "{}") as { turns: unknown[]; canInterject: boolean };
      expect(detail.turns).toHaveLength(1);
      expect(detail.canInterject).toBe(true);
    });
  });

  it("lists and reads issue-less consultation runs with null identity fields", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createConsultationRun(runStore);

    await withApiServer({ runStore, eventLog }, async (port) => {
      const list = await getJson(port, "/api/run-store/runs?limit=10");
      expect(list.status).toBe(200);
      expect((list.body as Array<Record<string, unknown>>)[0]).toMatchObject({
        runId: run.runId,
        command: "consult",
        issueNumber: null,
        pullRequestNumber: null,
      });

      const detail = await getJson(port, `/api/run-store/runs/${run.runId}`);
      expect(detail.status).toBe(200);
      const body = detail.body as { state: Record<string, unknown>; pipeline: unknown[] };
      expect(body.state).toMatchObject({
        command: "consult",
        issueNumber: null,
        branch: null,
        baseRef: null,
        baseSha: null,
        headSha: null,
      });
      expect(body.pipeline).toEqual([]);
    });
  });

  it("returns consultation discussion detail with interjection but without approval decision", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createConsultationRun(runStore);
    const store = new FileSystemDiscussionStore({ runStore, runId: run.runId });
    await store.appendTurn(discussionTurn("consult turn"));
    await store.saveConclusion(discussionConclusion("consult conclusion"));

    await withApiServer({ runStore, eventLog }, async (port) => {
      const response = await getJson(port, `/api/run-store/runs/${run.runId}/discussion`);
      expect(response.status).toBe(200);
      const detail = response.body as {
        turns: unknown[];
        conclusion: { conclusion: string } | null;
        approval: unknown;
        canInterject: boolean;
        canDecide: boolean;
      };
      expect(detail.turns).toHaveLength(1);
      expect(detail.conclusion?.conclusion).toBe("consult conclusion");
      expect(detail.approval).toBeNull();
      expect(detail.canInterject).toBe(true);
      expect(detail.canDecide).toBe(false);
    });
  });

  it("streams consultation discussion detail when consultation events arrive", async () => {
    const { runStore, eventLog } = await createFixture();
    const run = await createConsultationRun(runStore);
    const store = new FileSystemDiscussionStore({ runStore, runId: run.runId });
    await store.appendTurn(discussionTurn());

    await withApiServer({ runStore, eventLog, pollMs: 15 }, async (port) => {
      const client = connectSse(port, `/api/run-store/runs/${run.runId}/stream`);
      await eventLog.append(
        run.runId,
        {
          type: "discussion.turn",
          runId: run.runId,
          turn: discussionTurn(),
          turnNumber: 1,
          maxTurns: 20,
        },
        "2026-11-28T12:00:00.000Z",
      );
      await waitFor(
        () => client.events.some((event) => event.name === "discussion"),
        "consultation discussion SSE event",
      );
      client.close();
      const event = client.events.find((candidate) => candidate.name === "discussion");
      const detail = JSON.parse(event?.data ?? "{}") as { turns: unknown[]; canDecide: boolean };
      expect(detail.turns).toHaveLength(1);
      expect(detail.canDecide).toBe(false);
    });
  });
});
