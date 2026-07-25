import { describe, expect, it } from "vitest";
import * as v from "valibot";
import type { AgentEvent } from "./agent-event.js";
import { AgentCapabilitySchema } from "./agent-capability.js";
import { AgentErrorCodeSchema, AgentErrorSchema } from "./agent-error.js";
import { AgentEventSchema } from "./agent-event.js";
import { AgentExecutionResultSchema } from "./agent-execution-result.js";
import { AgentPromptSchema } from "./agent-prompt.js";

const now = new Date().toISOString();

describe("AgentEventSchema", () => {
  it("parses and round-trips session.started", () => {
    const event = { type: "session.started" as const, sessionId: "s-1", at: now };
    const parsed = v.parse(AgentEventSchema, event);
    const roundTrip = v.parse(AgentEventSchema, JSON.parse(JSON.stringify(parsed)));
    expect(roundTrip).toEqual(parsed);
  });

  it("parses message.delta", () => {
    const event = { type: "message.delta" as const, sessionId: "s-1", text: "hello", at: now };
    expect(
      (v.parse(AgentEventSchema, event) as Extract<AgentEvent, { type: "message.delta" }>).text,
    ).toBe("hello");
  });

  it("parses tool.started and completed", () => {
    const started = {
      type: "tool.started" as const,
      sessionId: "s-1",
      tool: "bash",
      toolCallId: "tc-1",
      summary: "run tests",
      at: now,
    };
    const completed = {
      type: "tool.completed" as const,
      sessionId: "s-1",
      tool: "bash",
      toolCallId: "tc-1",
      exitCode: 0,
      status: "completed",
      at: now,
    };
    expect(v.parse(AgentEventSchema, started).type).toBe("tool.started");
    expect(
      (v.parse(AgentEventSchema, completed) as Extract<AgentEvent, { type: "tool.completed" }>)
        .exitCode,
    ).toBe(0);
  });

  it("parses file.changed", () => {
    const event = {
      type: "file.changed" as const,
      sessionId: "s-1",
      path: "src/index.ts",
      at: now,
    };
    expect(
      (v.parse(AgentEventSchema, event) as Extract<AgentEvent, { type: "file.changed" }>).path,
    ).toBe("src/index.ts");
  });

  it("parses approval.required", () => {
    const event = {
      type: "approval.required" as const,
      sessionId: "s-1",
      requestId: "r-1",
      summary: "approve git push",
      at: now,
    };
    expect(
      (v.parse(AgentEventSchema, event) as Extract<AgentEvent, { type: "approval.required" }>)
        .requestId,
    ).toBe("r-1");
  });

  it("parses turn.completed", () => {
    const event = {
      type: "turn.completed" as const,
      sessionId: "s-1",
      stopReason: "completed",
      at: now,
    };
    expect(
      (v.parse(AgentEventSchema, event) as Extract<AgentEvent, { type: "turn.completed" }>)
        .stopReason,
    ).toBe("completed");
  });

  it("parses session.failed", () => {
    const event = {
      type: "session.failed" as const,
      sessionId: "s-1",
      error: { code: "process_crashed" as const, message: "devin exited", isRetryable: false },
      at: now,
    };
    const parsed = v.parse(AgentEventSchema, event);
    expect((parsed as Extract<AgentEvent, { type: "session.failed" }>).error.code).toBe(
      "process_crashed",
    );
  });

  it("parses unknown", () => {
    const event = { type: "unknown" as const, sessionId: "s-1", rawType: "foo.bar", at: now };
    expect(
      (v.parse(AgentEventSchema, event) as Extract<AgentEvent, { type: "unknown" }>).rawType,
    ).toBe("foo.bar");
  });

  it("rejects an unrecognized type", () => {
    const result = v.safeParse(AgentEventSchema, { type: "foo.bar", sessionId: "s-1", at: now });
    expect(result.success).toBe(false);
  });

  it("strips unknown fields from events", () => {
    const event = {
      type: "message.delta" as const,
      sessionId: "s-1",
      text: "hi",
      at: now,
      extra: "should be removed",
    };
    const parsed = v.parse(AgentEventSchema, event);
    expect(parsed).not.toHaveProperty("extra");
  });
});

describe("AgentErrorSchema", () => {
  it("parses a valid error", () => {
    const error = { code: "timeout" as const, message: "timed out" };
    const parsed = v.parse(AgentErrorSchema, error);
    expect(parsed.isRetryable).toBe(false);
  });

  it("rejects an invalid code", () => {
    const result = v.safeParse(AgentErrorSchema, { code: "invalid_code", message: "x" });
    expect(result.success).toBe(false);
  });

  it("strips vendor-specific fields", () => {
    const error = { code: "timeout" as const, message: "timed out", rawStack: "secret info" };
    const parsed = v.parse(AgentErrorSchema, error);
    expect(parsed).not.toHaveProperty("rawStack");
  });
});

describe("AgentErrorCodeSchema", () => {
  it("parses all known codes", () => {
    const codes = [
      "executable_not_found",
      "unsupported_version",
      "unauthenticated",
      "protocol_initialization_failure",
      "protocol_violation",
      "malformed_message",
      "permission_denied",
      "timeout",
      "cancelled",
      "process_crashed",
      "cleanup_failed",
      "policy_blocked",
      "unknown",
    ] as const;
    for (const code of codes) {
      expect(v.parse(AgentErrorCodeSchema, code)).toBe(code);
    }
  });

  it("rejects an unknown code", () => {
    const result = v.safeParse(AgentErrorCodeSchema, "foo");
    expect(result.success).toBe(false);
  });
});

describe("AgentPromptSchema", () => {
  it("parses a minimal prompt", () => {
    const prompt = { content: "implement" };
    expect(v.parse(AgentPromptSchema, prompt).content).toBe("implement");
  });

  it("strips vendor-specific metadata from prompt", () => {
    const prompt = { content: "implement", metadata: { rawVendorPayload: "secret" } };
    const parsed = v.parse(AgentPromptSchema, prompt);
    expect(parsed).not.toHaveProperty("metadata");
  });
});

describe("AgentExecutionResultSchema", () => {
  it("parses a completed result", () => {
    const result = { status: "completed" as const, sessionId: "s-1", unresolvedItems: ["a"] };
    const parsed = v.parse(AgentExecutionResultSchema, result);
    expect(parsed.unresolvedItems).toEqual(["a"]);
  });

  it("defaults unresolvedItems to empty array", () => {
    const result = { status: "completed" as const, sessionId: "s-1" };
    const parsed = v.parse(AgentExecutionResultSchema, result);
    expect(parsed.unresolvedItems).toEqual([]);
  });

  it("parses a failed result with error", () => {
    const result = {
      status: "failed" as const,
      sessionId: "s-1",
      error: { code: "timeout" as const, message: "x" },
    };
    const parsed = v.parse(AgentExecutionResultSchema, result);
    expect(parsed.error?.code).toBe("timeout");
  });
});

describe("AgentCapabilitySchema", () => {
  it("parses capability", () => {
    const cap = { protocol: "acp", protocolVersion: "1.0", agentName: "devin" };
    const parsed = v.parse(AgentCapabilitySchema, cap);
    expect(parsed.agentName).toBe("devin");
  });
});
