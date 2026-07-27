import type { AgentError } from "@meguribi/core";
import { ProcessError } from "@meguribi/process";

/**
 * Adapter-internal ACP transport errors.
 * SDK / Node errors must be converted before leaving this module.
 */
export type AcpTransportErrorCode =
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

export class AcpTransportError extends Error {
  readonly code: AcpTransportErrorCode;
  readonly isRetryable: boolean;

  constructor(code: AcpTransportErrorCode, message: string, isRetryable = false) {
    super(message);
    this.name = "AcpTransportError";
    this.code = code;
    this.isRetryable = isRetryable;
  }

  toAgentError(): AgentError {
    const map: Record<AcpTransportErrorCode, AgentError["code"]> = {
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

export function isAcpTransportError(error: unknown): error is AcpTransportError {
  return error instanceof AcpTransportError;
}

/**
 * Convert SDK / Node / Process errors into adapter-domain transport errors.
 */
export function toAcpTransportError(
  error: unknown,
  fallback: AcpTransportErrorCode,
): AcpTransportError {
  if (error instanceof AcpTransportError) {
    return error;
  }
  if (error instanceof ProcessError) {
    if (error.code === "executable_not_found") {
      return new AcpTransportError("spawn_failure", error.message);
    }
    if (error.code === "permission_denied") {
      return new AcpTransportError("permission_denied", error.message);
    }
    if (error.code === "timeout") {
      return new AcpTransportError("startup_timeout", error.message, true);
    }
    if (error.code === "cancelled") {
      return new AcpTransportError("cancelled", error.message);
    }
    if (error.code === "process_crashed") {
      return new AcpTransportError("process_crashed", error.message);
    }
  }
  const message = error instanceof Error ? error.message : "Unknown ACP transport error";
  if (/capability mismatch/i.test(message)) {
    return new AcpTransportError("capability_mismatch", message);
  }
  if (/load session failed/i.test(message)) {
    return new AcpTransportError("session_creation_failure", message);
  }
  if (/session creation failed/i.test(message)) {
    return new AcpTransportError("session_creation_failure", message);
  }
  if (/timeout/i.test(message)) {
    return new AcpTransportError("startup_timeout", message, true);
  }
  if (/JSON|NDJSON|parse|malformed/i.test(message)) {
    return new AcpTransportError("malformed_message", message);
  }
  // Prefer connection_closed over prompt_send_failure / initialize_failure.
  if (/connection closed|ACP connection closed|ECONNRESET|socket hang up|stream.*(closed|ended)/i.test(message)) {
    return new AcpTransportError("connection_closed", message);
  }
  if (/initialize/i.test(message)) {
    return new AcpTransportError("initialize_failure", message);
  }
  return new AcpTransportError(fallback, message);
}
