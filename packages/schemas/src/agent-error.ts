import * as v from "valibot";
import type {
  AgentError as CoreAgentError,
  AgentErrorCode as CoreAgentErrorCode,
} from "@meguribi/core";

export const AgentErrorCodeSchema = v.picklist([
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
  "unsupported_signal",
  "cleanup_failed",
  "policy_blocked",
  "unknown",
]) satisfies v.GenericSchema<unknown, CoreAgentErrorCode>;

export const AgentErrorSchema = v.object({
  code: AgentErrorCodeSchema,
  message: v.string(),
  isRetryable: v.optional(v.boolean(), false),
}) satisfies v.GenericSchema<unknown, CoreAgentError>;

export type AgentError = v.InferOutput<typeof AgentErrorSchema>;
export type AgentErrorCode = v.InferOutput<typeof AgentErrorCodeSchema>;
