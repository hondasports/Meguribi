import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./agent-event.js";
import { createLiveLogRenderer, type LiveLogEvent } from "./live-log.js";

const ev = (event: AgentEvent): LiveLogEvent => ({
  type: "agent.event",
  stepId: "implement",
  profileId: "devin",
  agentLabel: "Devin",
  role: "implementer",
  event,
});
const at = (s: number) => new Date(Date.UTC(2026, 10, 27, 0, 0, s)).toISOString();

describe("createLiveLogRenderer", () => {
  it("streams messages and tools like an agent CLI", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false });
    const out = [
      r.render({ type: "step.started", stepId: "implement", label: "implement", role: "implementer", agentLabel: "Devin" }),
      r.render(ev({ type: "message.delta", sessionId: "s", text: "確認して", at: at(0) })),
      r.render(ev({ type: "message.delta", sessionId: "s", text: "から直します。", at: at(1) })),
      r.render(ev({ type: "tool.started", sessionId: "s", tool: "Terminal", toolCallId: "t1", summary: "pnpm test", at: at(2) })),
      r.render(ev({ type: "tool.completed", sessionId: "s", tool: "Terminal", toolCallId: "t1", exitCode: 0, at: at(14) })),
    ].join("");
    expect(out).toBe(
      "── implement · Devin (implementer) " + "─".repeat(64 - 35) + "\n" +
      "● Devin  確認してから直します。\n" +
      "● Terminal  pnpm test\n" +
      "  └ completed · exit 0 · 12.0s\n");
  });
  it("redacts and truncates tool summaries", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false, redact: (t) => t.replace(/token=\S+/g, "token=[REDACTED]") });
    expect(r.render(ev({ type: "tool.started", sessionId: "s", tool: "Terminal", summary: "curl token=abc", at: at(0) }))).toBe("● Terminal  curl token=[REDACTED]\n");
    expect(r.render(ev({ type: "tool.started", sessionId: "s", tool: "Read", summary: "x".repeat(130), at: at(0) }))).toBe(`● Read  ${"x".repeat(120)}…\n`);
  });
  it("renders permission decisions in Japanese", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false });
    expect(r.render(ev({ type: "approval.required", sessionId: "s", requestId: "p", summary: "git push", decision: { outcome: "deny", reason: "git_write is not permitted" }, at: at(0) })))
      .toBe("⚠ 権限  git push → 拒否（git_write is not permitted）\n");
  });
  it("emits no ANSI codes when color is off and closes open lines on flush", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false });
    const out = r.render(ev({ type: "message.delta", sessionId: "s", text: "途中", at: at(0) })) + r.flush();
    expect(out).toBe("● Devin  途中\n");
    expect(out.includes("\u001b[")).toBe(false);
  });
  it("colors agent labels when color is on", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: true });
    expect(r.render(ev({ type: "message.delta", sessionId: "s", text: "a", at: at(0) }))).toContain("\u001b[36mDevin\u001b[0m");
  });
  it("renders only the selected agent for per-agent panes", () => {
    const r = createLiveLogRenderer({ mode: "stream", color: false, onlyProfileId: "codex" });
    expect(r.render({ type: "step.started", stepId: "implement", label: "implement", role: "implementer", profileId: "devin", agentLabel: "Devin" })).toBe("");
    expect(r.render(ev({ type: "tool.started", sessionId: "s", tool: "Edit", summary: "a.ts", at: at(0) }))).toBe("");
    expect(r.render({ type: "agent.event", stepId: "plan", profileId: "codex", agentLabel: "Codex", role: "planner",
      event: { type: "tool.started", sessionId: "c", tool: "Read", summary: "a.ts", at: at(0) } })).toBe("● Read  a.ts\n");
  });
  it("compact mode hides messages and completions", () => {
    const r = createLiveLogRenderer({ mode: "compact", color: false });
    expect(r.render(ev({ type: "message.delta", sessionId: "s", text: "a", at: at(0) }))).toBe("");
    expect(r.render(ev({ type: "tool.started", sessionId: "s", tool: "Edit", summary: "src/a.ts", at: at(0) }))).toBe("  · Edit  src/a.ts\n");
    expect(r.render(ev({ type: "tool.completed", sessionId: "s", tool: "Edit", at: at(1) }))).toBe("");
  });
});
