import type { AgentError } from "./agent-error.js";

/**
 * エージェントセッションの終了結果。
 */
export interface AgentExecutionResult {
  status: "completed" | "cancelled" | "timed_out" | "failed" | "blocked";
  sessionId: string;
  stopReason?: string;
  summary?: string;
  unresolvedItems: string[];
  reportedFiles?: string[];
  error?: AgentError;
}
