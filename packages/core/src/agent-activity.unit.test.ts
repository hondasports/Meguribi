import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./agent-event.js";
import { deriveAgentActivity } from "./agent-activity.js";
import type { AgentRole } from "./role-agent.js";
import type { WorkflowEvent } from "./workflow-engine/events.js";

const base = Date.UTC(2026, 10, 27, 12, 0, 0);
const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();

function agentEvent(
  event: AgentEvent,
  input: {
    stepId?: string;
    profileId?: string;
    agentLabel?: string;
    role?: AgentRole;
  } = {},
): WorkflowEvent {
  return {
    type: "agent.event",
    stepId: input.stepId ?? "implement",
    profileId: input.profileId ?? "devin",
    agentLabel: input.agentLabel ?? "Devin",
    role: input.role ?? "implementer",
    event,
  };
}

describe("deriveAgentActivity", () => {
  it("derives running_tool with detail, tool count, and stall timing", () => {
    const events = [
      agentEvent({ type: "session.started", sessionId: "s1", at: at(0) }),
      agentEvent({
        type: "tool.started",
        sessionId: "s1",
        tool: "Terminal",
        toolCallId: "tool-1",
        summary: "pnpm test",
        at: at(1000),
      }),
    ];

    const stalled = deriveAgentActivity(events, {
      now: new Date(base + 1000 + 120000),
    });
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toMatchObject({
      profileId: "devin",
      agentLabel: "Devin",
      role: "implementer",
      stepId: "implement",
      state: "running_tool",
      detail: "pnpm test",
      since: at(1000),
      lastEventAt: at(1000),
      toolCalls: 1,
      stalled: true,
      stalledForMs: 120000,
    });

    const notStalled = deriveAgentActivity(events, {
      now: new Date(base + 1000 + 119999),
    });
    expect(notStalled[0]).toMatchObject({ stalled: false, stalledForMs: 0 });
  });

  it("concatenates consecutive message deltas before truncating detail to 80 characters", () => {
    const events = [
      agentEvent({ type: "message.delta", sessionId: "s1", text: "a".repeat(50), at: at(100) }),
      agentEvent({ type: "message.delta", sessionId: "s1", text: "b".repeat(50), at: at(200) }),
    ];

    const [activity] = deriveAgentActivity(events, { now: new Date(base + 200) });
    expect(activity).toMatchObject({
      state: "thinking",
      since: at(100),
      lastEventAt: at(200),
    });
    expect(activity?.detail).toBe(`${"a".repeat(50)}${"b".repeat(30)}`);
    expect(activity?.detail).toHaveLength(80);
  });

  it("starts a new message detail after a non-message event", () => {
    const events = [
      agentEvent({ type: "message.delta", sessionId: "s1", text: "before-", at: at(100) }),
      agentEvent({ type: "tool.started", sessionId: "s1", tool: "Read", at: at(200) }),
      agentEvent({ type: "tool.completed", sessionId: "s1", tool: "Read", at: at(300) }),
      agentEvent({ type: "message.delta", sessionId: "s1", text: "after", at: at(400) }),
    ];

    const [activity] = deriveAgentActivity(events, { now: new Date(base + 400) });
    expect(activity).toMatchObject({ state: "thinking", detail: "after" });
  });

  it("tracks approvals, unique changed files, and idle completion", () => {
    const events = [
      agentEvent({
        type: "approval.required",
        sessionId: "s1",
        requestId: "permission-1",
        summary: "git push",
        at: at(100),
      }),
      agentEvent({ type: "file.changed", sessionId: "s1", path: "src/a.ts", at: at(200) }),
      agentEvent({ type: "file.changed", sessionId: "s1", path: "src/a.ts", at: at(300) }),
      agentEvent({ type: "file.changed", sessionId: "s1", path: "src/b.ts", at: at(400) }),
      agentEvent({ type: "turn.completed", sessionId: "s1", at: at(500) }),
    ];

    const [activity] = deriveAgentActivity(events, { now: new Date(base + 500) });
    expect(activity).toMatchObject({
      state: "idle",
      since: at(500),
      lastEventAt: at(500),
      changedFiles: ["src/a.ts", "src/b.ts"],
      stalled: false,
    });
  });

  it("returns profiles in first appearance order", () => {
    const events = [
      agentEvent(
        { type: "session.started", sessionId: "codex-session", at: at(100) },
        { profileId: "codex", agentLabel: "Codex", role: "planner", stepId: "plan" },
      ),
      agentEvent({ type: "session.started", sessionId: "devin-session", at: at(200) }),
      agentEvent(
        { type: "message.delta", sessionId: "codex-session", text: "planning", at: at(300) },
        { profileId: "codex", agentLabel: "Codex", role: "planner", stepId: "plan" },
      ),
    ];

    const activities = deriveAgentActivity(events, { now: new Date(base + 300) });
    expect(activities.map((activity) => activity.profileId)).toEqual(["codex", "devin"]);
  });

  it("resets step counters and changed files when the profile enters a different step", () => {
    const events: WorkflowEvent[] = [
      agentEvent({
        type: "tool.started",
        sessionId: "s1",
        tool: "Edit",
        summary: "src/a.ts",
        at: at(100),
      }),
      agentEvent({ type: "file.changed", sessionId: "s1", path: "src/a.ts", at: at(200) }),
      {
        type: "step.started",
        stepId: "fix",
        label: "fix",
        role: "implementer",
        profileId: "devin",
        agentLabel: "Devin",
      },
      agentEvent({ type: "session.started", sessionId: "s2", at: at(300) }, { stepId: "fix" }),
    ];

    const [activity] = deriveAgentActivity(events, { now: new Date(base + 300) });
    expect(activity).toMatchObject({
      stepId: "fix",
      state: "starting",
      toolCalls: 0,
      changedFiles: [],
    });
  });

  it("marks unfinished profiles finished on workflow.finished but preserves failed", () => {
    const events: WorkflowEvent[] = [
      agentEvent({ type: "message.delta", sessionId: "s1", text: "working", at: at(100) }),
      agentEvent(
        {
          type: "session.failed",
          sessionId: "s2",
          error: { code: "timeout", message: "timed out", isRetryable: false },
          at: at(200),
        },
        { profileId: "codex", agentLabel: "Codex", role: "planner", stepId: "plan" },
      ),
      {
        type: "workflow.finished",
        runId: "run-1",
        workflow: "delivery",
        outcome: "completed",
        at: at(300),
      },
    ];

    const activities = deriveAgentActivity(events, { now: new Date(base + 300) });
    expect(activities.find((activity) => activity.profileId === "devin")).toMatchObject({
      state: "finished",
      since: at(300),
    });
    expect(activities.find((activity) => activity.profileId === "codex")).toMatchObject({
      state: "failed",
      since: at(200),
    });
  });

  it("uses the tool name when a tool has no summary", () => {
    const [activity] = deriveAgentActivity(
      [agentEvent({ type: "tool.started", sessionId: "s1", tool: "Read", at: at(100) })],
      { now: new Date(base + 100) },
    );
    expect(activity).toMatchObject({ detail: "Read" });
  });
});
