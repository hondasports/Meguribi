import * as v from "valibot";
import type {
  ImplementationArtifactPaths as CoreArtifactPaths,
  ImplementationPermissionDecision as CorePermissionDecision,
  ImplementationResult as CoreImplementationResult,
} from "@meguribi/core";
import { AgentErrorSchema } from "./agent-error.js";
import { AgentTerminationResultSchema } from "./devin-safety.js";

const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(0));

export const ImplementationPermissionDecisionSchema = v.strictObject({
  requestId: v.string(),
  outcome: v.picklist(["approve", "deny", "confirm"]),
  reason: v.string(),
}) satisfies v.GenericSchema<unknown, CorePermissionDecision>;

export const ImplementationArtifactPathsSchema = v.strictObject({
  root: v.string(),
  rawEvents: v.optional(v.string()),
  events: v.optional(v.string()),
  result: v.optional(v.string()),
  gitBoundary: v.optional(v.string()),
  termination: v.optional(v.string()),
  prompt: v.optional(v.string()),
  stderr: v.optional(v.string()),
}) satisfies v.GenericSchema<unknown, CoreArtifactPaths>;

export const McpPolicyDecisionSchema = v.strictObject({
  outcome: v.picklist(["allow", "confirm", "block"]),
  reason: v.string(),
  warning: v.string(),
});

export const ImplementationResultSchema = v.strictObject({
  status: v.picklist(["completed", "blocked", "cancelled", "timed_out", "failed"]),
  sessionId: v.string(),
  startedAt: v.string(),
  finishedAt: v.string(),
  durationMs: positiveInteger,
  stopReason: v.optional(v.string()),
  changedFiles: v.array(v.string()),
  reportedFiles: v.array(v.string()),
  unresolvedItems: v.array(v.string()),
  permissionDecisions: v.array(ImplementationPermissionDecisionSchema),
  mcpPolicyResult: v.optional(McpPolicyDecisionSchema),
  termination: v.optional(AgentTerminationResultSchema),
  artifactPaths: ImplementationArtifactPathsSchema,
  promptVersion: v.optional(v.string()),
  promptHash: v.optional(v.string()),
  publishable: v.boolean(),
  error: v.optional(AgentErrorSchema),
  secondaryError: v.optional(AgentErrorSchema),
}) satisfies v.GenericSchema<unknown, CoreImplementationResult>;

export type ImplementationResult = v.InferOutput<typeof ImplementationResultSchema>;
export type ImplementationPermissionDecision = v.InferOutput<
  typeof ImplementationPermissionDecisionSchema
>;
export type ImplementationArtifactPaths = v.InferOutput<typeof ImplementationArtifactPathsSchema>;
