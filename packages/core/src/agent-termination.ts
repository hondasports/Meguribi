import type { AgentError } from "./agent-error.js";

export type AgentTerminationReason = "completed" | "cancelled" | "timed_out" | "crashed" | "protocol_error";

export interface AgentTerminationResult {
  reason: AgentTerminationReason;
  stopReason?: string;
  stdinClosed: boolean;
  cancelSent: boolean;
  gracefulExit: boolean;
  terminateSent: boolean;
  forceKillUsed: boolean;
  residualProcesses: number;
  cleanupError?: AgentError;
}
