import { describe, expect, it } from "vitest";
import {
  normalizePermissionRequest,
  normalizeSessionUpdate,
  normalizeTurnCompleted,
  pathsFromToolCall,
} from "./events.js";

describe("normalizeSessionUpdate", () => {
  const at = "2026-07-26T00:00:00.000Z";

  it("maps agent_message_chunk to message.delta", () => {
    const events = normalizeSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
      at,
    );
    expect(events).toEqual([
      { type: "message.delta", sessionId: "s-1", text: "hello", at },
    ]);
  });

  it("maps tool_call and emits file.changed from locations", () => {
    const events = normalizeSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t-1",
          name: "edit",
          title: "Edit README.md",
          locations: [{ path: "/tmp/work/README.md" }],
        },
      },
      at,
    );
    expect(events).toEqual([
      {
        type: "tool.started",
        sessionId: "s-1",
        tool: "edit",
        toolCallId: "t-1",
        summary: "Edit README.md",
        at,
      },
      {
        type: "file.changed",
        sessionId: "s-1",
        path: "/tmp/work/README.md",
        at,
      },
    ]);
  });

  it("maps completed tool_call_update to tool.completed", () => {
    const events = normalizeSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t-1",
          name: "edit",
          status: "completed",
        },
      },
      at,
    );
    expect(events).toEqual([
      {
        type: "tool.completed",
        sessionId: "s-1",
        tool: "edit",
        toolCallId: "t-1",
        status: "completed",
        at,
      },
    ]);
  });

  it("maps unknown sessionUpdate to agent.unknown without advancing meaning", () => {
    const events = normalizeSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "secret thought" },
        },
      },
      at,
    );
    expect(events).toEqual([
      {
        type: "unknown",
        sessionId: "s-1",
        rawType: "agent_thought_chunk",
        at,
      },
    ]);
  });

  it("maps permission and turn completion helpers", () => {
    expect(
      normalizePermissionRequest({
        sessionId: "s-1",
        requestId: "r-1",
        summary: "Edit file",
        at,
      }),
    ).toEqual({
      type: "approval.required",
      sessionId: "s-1",
      requestId: "r-1",
      summary: "Edit file",
      at,
    });
    expect(
      normalizeTurnCompleted({
        sessionId: "s-1",
        stopReason: "end_turn",
        at,
      }),
    ).toEqual({
      type: "turn.completed",
      sessionId: "s-1",
      stopReason: "end_turn",
      at,
    });
  });

  it("pathsFromToolCall ignores non-tool updates", () => {
    expect(
      pathsFromToolCall({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x" },
      }),
    ).toEqual([]);
  });
});
