import { describe, expect, it } from "vitest";
import { createMemoryRunStore } from "@meguribi/adapters";
import type {
  AgentEvent,
  RunState,
  WorkflowEvent,
  WorkflowEventLog,
  WorkflowEventRecord,
} from "@meguribi/core";
import { createProgram } from "../program.js";
import { runStatusCommand } from "./status.js";

class MemoryWorkflowEventLog implements WorkflowEventLog {
  readonly entries: (WorkflowEventRecord | null)[] = [];

  async append(_runId: string, event: WorkflowEvent, at = "2026-11-27T12:00:00.000Z"): Promise<void> {
    this.entries.push({ at, event });
  }

  async read(_runId: string, fromLine = 0): Promise<{
    records: WorkflowEventRecord[];
    nextLine: number;
    skippedLines: number;
  }> {
    const slice = this.entries.slice(fromLine);
    return {
      records: slice.filter((entry): entry is WorkflowEventRecord => entry !== null),
      nextLine: this.entries.length,
      skippedLines: slice.filter((entry) => entry === null).length,
    };
  }
}

async function createTestRun(input: {
  status?: RunState["status"];
  fixAttempts?: number;
} = {}): Promise<{
  runStore: ReturnType<typeof createMemoryRunStore>;
  state: RunState;
}> {
  const runStore = createMemoryRunStore({
    now: () => new Date("2026-11-27T12:00:00.000Z"),
  });
  const created = await runStore.create({
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
  const state = await runStore.update(created.runId, {
    status: input.status ?? "implementing",
    currentStep: "implementing",
    fixAttempts: input.fixAttempts ?? 0,
  });
  return { runStore, state };
}

function agentEvent(event: AgentEvent, input: {
  stepId?: string;
  profileId?: string;
  agentLabel?: string;
  role?: "implementer" | "planner" | "reviewer";
} = {}): WorkflowEvent {
  return {
    type: "agent.event",
    stepId: input.stepId ?? "implement",
    profileId: input.profileId ?? "devin",
    agentLabel: input.agentLabel ?? "Devin",
    role: input.role ?? "implementer",
    event,
  };
}

function record(event: WorkflowEvent, at = "2026-11-27T12:00:00.000Z"): WorkflowEventRecord {
  return { at, event };
}

function toolStarted(at: string, input: { profileId?: string; agentLabel?: string; role?: "implementer" | "planner" | "reviewer" } = {}): WorkflowEvent {
  return agentEvent(
    {
      type: "tool.started",
      sessionId: `${input.profileId ?? "devin"}-session`,
      tool: "Terminal",
      toolCallId: "tool-1",
      summary: "pnpm test",
      at,
    },
    input,
  );
}

describe("runStatusCommand", () => {
  it("prints run state and agent activity once", async () => {
    const { runStore, state } = await createTestRun({ fixAttempts: 1 });
    const eventLog = new MemoryWorkflowEventLog();
    eventLog.entries.push(record(toolStarted("2026-11-27T12:00:00.000Z")));
    const stdout: string[] = [];

    const result = await runStatusCommand(
      state.runId,
      {},
      {
        runStore,
        eventLog,
        now: () => new Date("2026-11-27T12:00:12.000Z"),
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(stdout.join("")).toBe(
      `Run: ${state.runId}  (owner/repo#76)\n` +
        "Status: implementing  Step: implementing  Fix: 1/2\n" +
        "Agents:\n" +
        "  Devin (implementer) running_tool pnpm test 12s\n",
    );
  });

  it("prints a no-response warning in minutes when activity is stalled", async () => {
    const { runStore, state } = await createTestRun();
    const eventLog = new MemoryWorkflowEventLog();
    eventLog.entries.push(record(toolStarted("2026-11-27T12:00:00.000Z")));
    const stdout: string[] = [];

    await runStatusCommand(
      state.runId,
      {},
      {
        runStore,
        eventLog,
        now: () => new Date("2026-11-27T12:02:00.000Z"),
        stdout: (text) => stdout.push(text),
      },
    );

    expect(stdout.join("")).toContain("running_tool pnpm test 2m00s  応答なし 2分");
  });

  it("prints a placeholder when no agent events exist", async () => {
    const { runStore, state } = await createTestRun();
    const stdout: string[] = [];

    await runStatusCommand(state.runId, {}, {
      runStore,
      eventLog: new MemoryWorkflowEventLog(),
      stdout: (text) => stdout.push(text),
    });

    expect(stdout.join("")).toContain("Agents: (no agent events yet)\n");
  });

  it("filters human output to the selected agent", async () => {
    const { runStore, state } = await createTestRun();
    const eventLog = new MemoryWorkflowEventLog();
    eventLog.entries.push(record(toolStarted("2026-11-27T12:00:00.000Z")));
    eventLog.entries.push(record(toolStarted("2026-11-27T12:00:01.000Z", {
      profileId: "codex",
      agentLabel: "Codex",
      role: "planner",
    })));
    const stdout: string[] = [];

    await runStatusCommand(state.runId, { agent: "codex" }, {
      runStore,
      eventLog,
      now: () => new Date("2026-11-27T12:00:02.000Z"),
      stdout: (text) => stdout.push(text),
    });

    expect(stdout.join("")).toContain("Codex (planner) running_tool");
    expect(stdout.join("")).not.toContain("Devin (implementer)");
  });

  it("explains when the selected agent has no events", async () => {
    const { runStore, state } = await createTestRun();
    const eventLog = new MemoryWorkflowEventLog();
    eventLog.entries.push(record(toolStarted("2026-11-27T12:00:00.000Z")));
    const stdout: string[] = [];

    await runStatusCommand(state.runId, { agent: "claude" }, {
      runStore,
      eventLog,
      stdout: (text) => stdout.push(text),
    });

    expect(stdout.join("")).toContain("この Run に claude のイベントはありません");
  });

  it("prints one-line JSON with state and filtered activities", async () => {
    const { runStore, state } = await createTestRun();
    const eventLog = new MemoryWorkflowEventLog();
    eventLog.entries.push(record(toolStarted("2026-11-27T12:00:00.000Z")));
    const stdout: string[] = [];

    const result = await runStatusCommand(state.runId, { json: true, agent: "devin" }, {
      runStore,
      eventLog,
      now: () => new Date("2026-11-27T12:00:01.000Z"),
      stdout: (text) => stdout.push(text),
    });

    expect(result.exitCode).toBe(0);
    const lines = stdout.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      state: RunState;
      activities: { profileId: string; state: string }[];
    };
    expect(parsed.state.runId).toBe(state.runId);
    expect(parsed.activities).toHaveLength(1);
    expect(parsed.activities[0]).toMatchObject({ profileId: "devin", state: "running_tool" });
  });

  it("reports a missing run with the next action and exit 1", async () => {
    const { runStore } = await createTestRun();
    const stderr: string[] = [];

    const result = await runStatusCommand("missing-run", {}, {
      runStore,
      eventLog: new MemoryWorkflowEventLog(),
      stderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.join("")).toBe(
      "Run not found: missing-run\n" +
        'Next: meguribi status に渡す runId は meguribi run / resume の出力の "Run:" 行で確認できます\n',
    );
  });

  it("streams existing and appended events in follow mode until the run reaches a terminal state", async () => {
    const { runStore, state } = await createTestRun();
    const eventLog = new MemoryWorkflowEventLog();
    eventLog.entries.push(record(agentEvent({
      type: "message.delta",
      sessionId: "devin-session",
      text: "hello",
      at: "2026-11-27T12:00:00.000Z",
    })));
    const stdout: string[] = [];
    let sleeps = 0;

    const result = await runStatusCommand(state.runId, { follow: true }, {
      runStore,
      eventLog,
      stdout: (text) => stdout.push(text),
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) {
          eventLog.entries.push(record(toolStarted("2026-11-27T12:00:01.000Z"), "2026-11-27T12:00:01.000Z"));
          await runStore.update(state.runId, { status: "awaiting_human" });
        }
      },
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.join("")).toContain("● Devin  hello\n");
    expect(stdout.join("")).toContain("● Terminal  pnpm test\n");
    expect(sleeps).toBe(1);
  });

  it("stops following when a discussion run reaches completed", async () => {
    const { runStore, state } = await createTestRun();
    const stdout: string[] = [];
    let sleeps = 0;

    const result = await runStatusCommand(state.runId, { follow: true }, {
      runStore,
      eventLog: new MemoryWorkflowEventLog(),
      stdout: (text) => stdout.push(text),
      sleep: async () => {
        sleeps += 1;
        await runStore.update(state.runId, { status: "completed" });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(sleeps).toBe(1);
  });

  it("renders discussion.turn and discussion.ended events in follow mode", async () => {
    const { runStore, state } = await createTestRun();
    const eventLog = new MemoryWorkflowEventLog();
    eventLog.entries.push(record({
      type: "discussion.turn",
      runId: state.runId,
      turn: {
        turnId: "t-1",
        speaker: "claude-code",
        speakerLabel: "Claude",
        envelope: {
          message: "A 案に賛成です",
          replyTo: [],
          addressTo: [],
          positions: [],
          newIssues: [],
          done: true,
        },
        malformed: false,
        at: "2026-11-27T12:00:00.000Z",
      },
      turnNumber: 1,
      maxTurns: 20,
    } as never));
    const stdout: string[] = [];

    const result = await runStatusCommand(state.runId, { follow: true }, {
      runStore,
      eventLog,
      stdout: (text) => stdout.push(text),
      sleep: async () => {
        eventLog.entries.push(record({
          type: "discussion.ended",
          runId: state.runId,
          endedBy: "consensus",
          turns: 2,
          at: "2026-11-27T12:00:01.000Z",
        } as never));
        await runStore.update(state.runId, { status: "awaiting_human" });
      },
    });

    expect(result.exitCode).toBe(0);
    const text = stdout.join("");
    expect(text).toContain("discuss · turn 1/20");
    expect(text).toContain("A 案に賛成です");
    expect(text).toContain("discuss ended: consensus (2 turns)");
  });

  it("waits in follow mode when the selected agent has no events and exits 0 on abort", async () => {
    const { runStore, state } = await createTestRun();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const controller = new AbortController();

    const result = await runStatusCommand(state.runId, { follow: true, agent: "claude" }, {
      runStore,
      eventLog: new MemoryWorkflowEventLog(),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      abortSignal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toBe("この Run に claude のイベントはまだありません。待機中…\n");
  });

  it("warns once about malformed event lines", async () => {
    const { runStore, state } = await createTestRun();
    const eventLog = new MemoryWorkflowEventLog();
    eventLog.entries.push(null);
    const stderr: string[] = [];

    const result = await runStatusCommand(state.runId, {}, {
      runStore,
      eventLog,
      stderr: (text) => stderr.push(text),
      stdout: () => undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.join("")).toBe("warning: skipped 1 malformed event line(s)\n");
  });
});

describe("status command registration", () => {
  it("registers meguribi status <runId>", async () => {
    const { runStore, state } = await createTestRun();
    const stdout: string[] = [];
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = createProgram({
        runStore,
        eventLog: new MemoryWorkflowEventLog(),
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
      });
      await program.parseAsync(["node", "meguribi", "status", state.runId]);
      expect(process.exitCode).toBe(0);
      expect(stdout.join("")).toContain(`Run: ${state.runId}`);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
