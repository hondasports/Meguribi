import type { AgentError } from "@meguribi/core";

/**
 * Adapter-internal ACP transport errors.
 * SDK / Node errors must be converted before leaving this module.
 */
export type DevinAcpTransportErrorCode =
  | "spawn_failure"
  | "startup_timeout"
  | "initialize_failure"
  | "capability_mismatch"
  | "session_creation_failure"
  | "prompt_send_failure"
  | "malformed_message"
  | "protocol_violation"
  | "connection_closed"
  | "process_crashed"
  | "cancelled"
  | "not_runnable"
  | "unknown";

export class DevinAcpTransportError extends Error {
  readonly code: DevinAcpTransportErrorCode;
  readonly isRetryable: boolean;

  constructor(code: DevinAcpTransportErrorCode, message: string, isRetryable = false) {
    super(message);
    this.name = "DevinAcpTransportError";
    this.code = code;
    this.isRetryable = isRetryable;
  }

  toAgentError(): AgentError {
    const map: Record<DevinAcpTransportErrorCode, AgentError["code"]> = {
      spawn_failure: "executable_not_found",
      startup_timeout: "timeout",
      initialize_failure: "protocol_initialization_failure",
      capability_mismatch: "protocol_initialization_failure",
      session_creation_failure: "protocol_initialization_failure",
      prompt_send_failure: "protocol_violation",
      malformed_message: "malformed_message",
      protocol_violation: "protocol_violation",
      connection_closed: "process_crashed",
      process_crashed: "process_crashed",
      cancelled: "cancelled",
      not_runnable: "policy_blocked",
      unknown: "unknown",
    };
    return {
      code: map[this.code],
      message: this.message,
      isRetryable: this.isRetryable,
    };
  }
}

export function isDevinAcpTransportError(error: unknown): error is DevinAcpTransportError {
  return error instanceof DevinAcpTransportError;
}
