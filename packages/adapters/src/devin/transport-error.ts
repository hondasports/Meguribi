import type { AgentError } from "@meguribi/core";
import { ProcessError } from "@meguribi/process";

/**
 * Adapter-internal ACP transport errors.
 * SDK / Node errors must be converted before leaving this module.
 */
export type DevinAcpTransportErrorCode =
  | "spawn_failure"
  | "permission_denied"
  | "startup_timeout"
  | "turn_timeout"
  | "initialize_failure"
  | "capability_mismatch"
  | "session_creation_failure"
  | "prompt_send_failure"
  | "malformed_message"
  | "protocol_violation"
  | "connection_closed"
  | "process_crashed"
  | "cancelled"
  | "policy_blocked"
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
      permission_denied: "permission_denied",
      startup_timeout: "timeout",
      turn_timeout: "timeout",
      initialize_failure: "protocol_initialization_failure",
      capability_mismatch: "protocol_initialization_failure",
      session_creation_failure: "protocol_initialization_failure",
      prompt_send_failure: "protocol_violation",
      malformed_message: "malformed_message",
      protocol_violation: "protocol_violation",
      connection_closed: "process_crashed",
      process_crashed: "process_crashed",
      cancelled: "cancelled",
      policy_blocked: "policy_blocked",
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

/**
 * Convert SDK / Node / Process errors into adapter-domain transport errors.
 */
export function toDevinAcpTransportError(
  error: unknown,
  fallback: DevinAcpTransportErrorCode,
): DevinAcpTransportError {
  if (error instanceof DevinAcpTransportError) {
    return error;
  }
  if (error instanceof ProcessError) {
    if (error.code === "executable_not_found") {
      return new DevinAcpTransportError("spawn_failure", error.message);
    }
    if (error.code === "permission_denied") {
      return new DevinAcpTransportError("permission_denied", error.message);
    }
    if (error.code === "timeout") {
      return new DevinAcpTransportError("startup_timeout", error.message, true);
    }
    if (error.code === "cancelled") {
      return new DevinAcpTransportError("cancelled", error.message);
    }
    if (error.code === "process_crashed") {
      return new DevinAcpTransportError("process_crashed", error.message);
    }
  }
  const message = error instanceof Error ? error.message : "Unknown ACP transport error";
  if (/capability mismatch/i.test(message)) {
    return new DevinAcpTransportError("capability_mismatch", message);
  }
  if (/session creation failed/i.test(message)) {
    return new DevinAcpTransportError("session_creation_failure", message);
  }
  if (/timeout/i.test(message)) {
    return new DevinAcpTransportError("startup_timeout", message, true);
  }
  if (/JSON|NDJSON|parse|malformed/i.test(message)) {
    return new DevinAcpTransportError("malformed_message", message);
  }
  // Prefer connection_closed over prompt_send_failure / initialize_failure.
  if (/connection closed|ACP connection closed|ECONNRESET|socket hang up|stream.*(closed|ended)/i.test(message)) {
    return new DevinAcpTransportError("connection_closed", message);
  }
  if (/initialize/i.test(message)) {
    return new DevinAcpTransportError("initialize_failure", message);
  }
  return new DevinAcpTransportError(fallback, message);
}
