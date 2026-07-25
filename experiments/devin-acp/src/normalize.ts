import type * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent } from "./types.js";

export function normalizeSessionUpdate(notification: acp.SessionNotification): AgentEvent[] {
  const { sessionId, update } = notification;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text"
        ? [{ type: "message.delta", sessionId, text: update.content.text }]
        : [];
    case "tool_call":
      return [{
        type: "tool.started",
        sessionId,
        tool: update.name ?? update.kind ?? "unknown",
        toolCallId: update.toolCallId,
        ...(update.title ? { summary: update.title } : {})
      }];
    case "tool_call_update": {
      const tool = update.name ?? update.kind ?? "unknown";
      if (update.status === "completed" || update.status === "failed") {
        return [{ type: "tool.completed", sessionId, tool, toolCallId: update.toolCallId, status: update.status }];
      }
      return [{
        type: "tool.started",
        sessionId,
        tool,
        toolCallId: update.toolCallId,
        ...(update.title ? { summary: update.title } : {})
      }];
    }
    default:
      return [];
  }
}

export function pathsFromToolCall(update: acp.SessionUpdate): string[] {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return [];
  }
  return (update.locations ?? []).flatMap((location) => {
    try {
      return [location.path];
    } catch {
      return [];
    }
  });
}
