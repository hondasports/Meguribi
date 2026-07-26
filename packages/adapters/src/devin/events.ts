import type { AgentEvent } from "@meguribi/core";

/**
 * Loose ACP session/update payload used after leaving the SDK boundary.
 * Unknown `sessionUpdate` values become `agent.unknown`.
 */
export type AcpSessionUpdatePayload = {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  name?: string;
  kind?: string;
  title?: string;
  status?: string;
  locations?: Array<{ path?: string }>;
  [key: string]: unknown;
};

export type AcpSessionNotificationPayload = {
  sessionId: string;
  update: AcpSessionUpdatePayload;
};

function nowIso(at?: string): string {
  return at ?? new Date().toISOString();
}

export function pathsFromToolCall(update: AcpSessionUpdatePayload): string[] {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return [];
  }
  const locations = update.locations ?? [];
  return locations.flatMap((location) => {
    if (typeof location.path === "string" && location.path.length > 0) {
      return [location.path];
    }
    return [];
  });
}

/**
 * Map ACP session/update payloads to domain AgentEvent values.
 * Does not advance workflow state; callers decide how to react.
 */
export function normalizeSessionUpdate(
  notification: AcpSessionNotificationPayload,
  at?: string,
): AgentEvent[] {
  const { sessionId, update } = notification;
  const timestamp = nowIso(at);
  const events: AgentEvent[] = [];

  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content?.type === "text" && typeof update.content.text === "string") {
        events.push({
          type: "message.delta",
          sessionId,
          text: update.content.text,
          at: timestamp,
        });
      }
      break;
    case "tool_call":
      events.push({
        type: "tool.started",
        sessionId,
        tool: update.name ?? update.kind ?? "unknown",
        ...(update.toolCallId ? { toolCallId: update.toolCallId } : {}),
        ...(update.title ? { summary: update.title } : {}),
        at: timestamp,
      });
      break;
    case "tool_call_update": {
      const tool = update.name ?? update.kind ?? "unknown";
      if (update.status === "completed" || update.status === "failed") {
        events.push({
          type: "tool.completed",
          sessionId,
          tool,
          ...(update.toolCallId ? { toolCallId: update.toolCallId } : {}),
          status: update.status,
          at: timestamp,
        });
      } else {
        events.push({
          type: "tool.started",
          sessionId,
          tool,
          ...(update.toolCallId ? { toolCallId: update.toolCallId } : {}),
          ...(update.title ? { summary: update.title } : {}),
          at: timestamp,
        });
      }
      break;
    }
    default:
      events.push({
        type: "unknown",
        sessionId,
        rawType: update.sessionUpdate,
        at: timestamp,
      });
      break;
  }

  for (const changedPath of pathsFromToolCall(update)) {
    events.push({
      type: "file.changed",
      sessionId,
      path: changedPath,
      at: timestamp,
    });
  }

  return events;
}

export function normalizePermissionRequest(input: {
  sessionId: string;
  requestId: string;
  summary: string;
  at?: string;
}): AgentEvent {
  return {
    type: "approval.required",
    sessionId: input.sessionId,
    requestId: input.requestId,
    summary: input.summary,
    at: nowIso(input.at),
  };
}

export function normalizeTurnCompleted(input: {
  sessionId: string;
  stopReason?: string;
  at?: string;
}): AgentEvent {
  return {
    type: "turn.completed",
    sessionId: input.sessionId,
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    at: nowIso(input.at),
  };
}

export function normalizeSessionStarted(sessionId: string, at?: string): AgentEvent {
  return {
    type: "session.started",
    sessionId,
    at: nowIso(at),
  };
}
