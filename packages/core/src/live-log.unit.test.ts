import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./agent-event.js";
import type { DiscussionTurn } from "./discussion/types.js";
import { createLiveLogRenderer, type LiveLogEvent } from "./live-log.js";
import type { WorkflowEvent } from "./workflow-engine/events.js";

const ev = (event: AgentEvent): LiveLogEvent => ({
  type: "agent.event",
  stepId: "implement",
  profileId: "devin",
  agentLabel: "Devin",
  role: "implementer",
  event,
});
const at = (s: number) => new Date(Date.UTC(2026, 10, 27, 0, 0, s)).toISOString();

function turn(
  input: {
    speaker?: string;
    speakerLabel?: string;
    message?: string;
    addressTo?: readonly string[];
    malformed?: boolean;
  } = {},
): DiscussionTurn {
  return {
    turnId: "t-1",
    speaker: input.speaker ?? "codex",
    speakerLabel: input.speakerLabel ?? "Codex",
    envelope: {
      message: input.message ?? "message",
      replyTo: [],
      addressTo: input.addressTo ?? [],
      positions: [],
      newIssues: [],
      done: false,
    },
    malformed: input.malformed ?? false,
    at: at(0),
  };
}

function discussionHeading(turnNumber: number, maxTurns = 20): string {
  const head = `── discuss · turn ${String(turnNumber)}/${String(maxTurns)} `;
  return `${head}${"─".repeat(64 - head.length)}\n`;
}

describe("createLiveLogRenderer", () => {
  it("streams messages and tools like an agent CLI", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false });
    const out = [
      r.render({
        type: "step.started",
        stepId: "implement",
        label: "implement",
        role: "implementer",
        agentLabel: "Devin",
      }),
      r.render(ev({ type: "message.delta", sessionId: "s", text: "確認して", at: at(0) })),
      r.render(ev({ type: "message.delta", sessionId: "s", text: "から直します。", at: at(1) })),
      r.render(
        ev({
          type: "tool.started",
          sessionId: "s",
          tool: "Terminal",
          toolCallId: "t1",
          summary: "pnpm test",
          at: at(2),
        }),
      ),
      r.render(
        ev({
          type: "tool.completed",
          sessionId: "s",
          tool: "Terminal",
          toolCallId: "t1",
          exitCode: 0,
          at: at(14),
        }),
      ),
    ].join("");
    expect(out).toBe(
      "── implement · Devin (implementer) " +
        "─".repeat(64 - 35) +
        "\n" +
        "● Devin  確認してから直します。\n" +
        "● Terminal  pnpm test\n" +
        "  └ completed · exit 0 · 12.0s\n",
    );
  });
  it("redacts and truncates tool summaries", () => {
    const r = createLiveLogRenderer({
      mode: "stream",
      color: false,
      redact: (t) => t.replace(/token=\S+/g, "token=[REDACTED]"),
    });
    expect(
      r.render(
        ev({
          type: "tool.started",
          sessionId: "s",
          tool: "Terminal",
          summary: "curl token=abc",
          at: at(0),
        }),
      ),
    ).toBe("● Terminal  curl token=[REDACTED]\n");
    expect(
      r.render(
        ev({
          type: "tool.started",
          sessionId: "s",
          tool: "Read",
          summary: "x".repeat(130),
          at: at(0),
        }),
      ),
    ).toBe(`● Read  ${"x".repeat(120)}…\n`);
  });
  it("renders permission decisions in Japanese", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false });
    expect(
      r.render(
        ev({
          type: "approval.required",
          sessionId: "s",
          requestId: "p",
          summary: "git push",
          decision: { outcome: "deny", reason: "git_write is not permitted" },
          at: at(0),
        }),
      ),
    ).toBe("⚠ 権限  git push → 拒否（git_write is not permitted）\n");
  });
  it("emits no ANSI codes when color is off and closes open lines on flush", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false });
    const out =
      r.render(ev({ type: "message.delta", sessionId: "s", text: "途中", at: at(0) })) + r.flush();
    expect(out).toBe("● Devin  途中\n");
    expect(out.includes("\u001b[")).toBe(false);
  });
  it("colors agent labels when color is on", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: true });
    expect(r.render(ev({ type: "message.delta", sessionId: "s", text: "a", at: at(0) }))).toContain(
      "\u001b[36mDevin\u001b[0m",
    );
  });
  it("renders only the selected agent for per-agent panes", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false, onlyProfileId: "codex" });
    expect(
      r.render({
        type: "step.started",
        stepId: "implement",
        label: "implement",
        role: "implementer",
        profileId: "devin",
        agentLabel: "Devin",
      }),
    ).toBe("");
    expect(
      r.render(
        ev({ type: "tool.started", sessionId: "s", tool: "Edit", summary: "a.ts", at: at(0) }),
      ),
    ).toBe("");
    expect(
      r.render({
        type: "agent.event",
        stepId: "plan",
        profileId: "codex",
        agentLabel: "Codex",
        role: "planner",
        event: { type: "tool.started", sessionId: "c", tool: "Read", summary: "a.ts", at: at(0) },
      }),
    ).toBe("● Read  a.ts\n");
  });
  it("renders workflow step progress", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false });
    expect(
      r.render({
        type: "step.progress",
        runId: "run-1",
        stepId: "verify",
        label: "verify",
        current: 1,
        max: 2,
        at: at(0),
      }),
    ).toBe("  · verify 1/2\n");
  });
  it("renders discussion turns with addressed participant labels in stream mode", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false });
    const firstTurn: Extract<WorkflowEvent, { type: "discussion.turn" }> = {
      type: "discussion.turn",
      runId: "run-1",
      turn: turn({
        speaker: "claude",
        speakerLabel: "Claude Code",
        message: "まず論点を整理します。",
      }),
      turnNumber: 1,
      maxTurns: 20,
    };
    const secondTurn: Extract<WorkflowEvent, { type: "discussion.turn" }> = {
      type: "discussion.turn",
      runId: "run-1",
      turn: turn({
        speaker: "codex",
        speakerLabel: "Codex",
        message: "ログを見ると夜間の開封率が低いので、量より時刻の問題です。",
        addressTo: ["claude"],
      }),
      turnNumber: 2,
      maxTurns: 20,
    };
    const out = [r.render(firstTurn), r.render(secondTurn)].join("");

    expect(out).toBe(
      discussionHeading(1) +
        "● Claude Code  まず論点を整理します。\n" +
        discussionHeading(2) +
        "● Codex → Claude Code  ログを見ると夜間の開封率が低いので、量より時刻の問題です。\n",
    );
  });
  it("renders human turns and malformed discussion turns", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false });
    const out = [
      r.render({
        type: "discussion.turn",
        runId: "run-1",
        turn: turn({
          speaker: "human",
          speakerLabel: "あなた",
          message: "既存の設定画面は変えたくない",
        }),
        turnNumber: 2,
        maxTurns: 20,
      }),
      r.render({
        type: "discussion.turn",
        runId: "run-1",
        turn: turn({ message: "broken envelope", malformed: true }),
        turnNumber: 3,
        maxTurns: 20,
      }),
    ].join("");

    expect(out).toBe(
      discussionHeading(2) +
        "● あなた  既存の設定画面は変えたくない\n" +
        discussionHeading(3) +
        "● Codex  broken envelope (形式不正)\n",
    );
  });
  it("redacts discussion messages before rendering", () => {
    const r = createLiveLogRenderer({
      mode: "stream",
      color: false,
      redact: (text) => text.replace(/token=\S+/g, "token=[REDACTED]"),
    });

    expect(
      r.render({
        type: "discussion.turn",
        runId: "run-1",
        turn: turn({ message: "curl token=abc は使えません" }),
        turnNumber: 1,
        maxTurns: 20,
      }),
    ).toBe(`${discussionHeading(1)}● Codex  curl token=[REDACTED] は使えません\n`);
  });
  it("renders discussion end as a compact boundary line", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false });
    const event: Extract<WorkflowEvent, { type: "discussion.ended" }> = {
      type: "discussion.ended",
      runId: "run-1",
      endedBy: "consensus",
      turns: 6,
      at: at(0),
    };

    expect(r.render(event)).toBe("── discuss ended: consensus (6 turns) ──\n");
  });
  it("compact mode renders only the discussion heading and first 80 message characters", () => {
    const r = createLiveLogRenderer({ mode: "compact", color: false });

    expect(
      r.render({
        type: "discussion.turn",
        runId: "run-1",
        turn: turn({ message: "a".repeat(81) }),
        turnNumber: 4,
        maxTurns: 20,
      }),
    ).toBe(`${discussionHeading(4)}● Codex  ${"a".repeat(80)}\n`);
  });
  it("onlyProfileId renders only that speaker's discussion turns", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false, onlyProfileId: "codex" });

    expect(
      r.render({
        type: "discussion.turn",
        runId: "run-1",
        turn: turn({ speaker: "claude", speakerLabel: "Claude Code" }),
        turnNumber: 1,
        maxTurns: 20,
      }),
    ).toBe("");
    expect(
      r.render({
        type: "discussion.turn",
        runId: "run-1",
        turn: turn({ speaker: "codex", speakerLabel: "Codex" }),
        turnNumber: 2,
        maxTurns: 20,
      }),
    ).toBe(`${discussionHeading(2)}● Codex  message\n`);
    expect(
      r.render({
        type: "discussion.ended",
        runId: "run-1",
        endedBy: "consensus",
        turns: 2,
        at: at(0),
      }),
    ).toBe("");
  });
  it("compact mode hides messages and completions", () => {
    const r = createLiveLogRenderer({ mode: "compact", color: false });
    expect(r.render(ev({ type: "message.delta", sessionId: "s", text: "a", at: at(0) }))).toBe("");
    expect(
      r.render(
        ev({ type: "tool.started", sessionId: "s", tool: "Edit", summary: "src/a.ts", at: at(0) }),
      ),
    ).toBe("  · Edit  src/a.ts\n");
    expect(r.render(ev({ type: "tool.completed", sessionId: "s", tool: "Edit", at: at(1) }))).toBe(
      "",
    );
  });
});
