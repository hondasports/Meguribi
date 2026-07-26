import type { AgentError } from "./agent-error.js";

/**
 * エージェントセッションから発行される正規化イベント。
 * `sessionId` は常に含め、ログ・再実行を可能にする。
 * `at` は ISO 8601 タイムスタンプ。
 */
export type AgentEvent =
  | { type: "session.started"; sessionId: string; at: string }
  | { type: "message.delta"; sessionId: string; text: string; at: string }
  | {
      type: "tool.started";
      sessionId: string;
      tool: string;
      toolCallId?: string;
      summary?: string;
      at: string;
    }
  | {
      type: "tool.completed";
      sessionId: string;
      tool: string;
      toolCallId?: string;
      exitCode?: number;
      status?: string;
      at: string;
    }
  | { type: "file.changed"; sessionId: string; path: string; at: string }
  | {
      type: "approval.required";
      sessionId: string;
      requestId: string;
      summary: string;
      decision?: { outcome: "approve" | "deny" | "confirm"; reason: string };
      at: string;
    }
  | { type: "turn.completed"; sessionId: string; stopReason?: string; at: string }
  | { type: "session.failed"; sessionId: string; error: AgentError; at: string }
  | { type: "unknown"; sessionId: string; rawType: string; at: string };
