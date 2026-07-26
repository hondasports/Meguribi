import * as v from "valibot";
import type {
  AgentTerminationResult as CoreAgentTerminationResult,
  ImplementationContext as CoreImplementationContext,
  PermissionRequest as CorePermissionRequest,
} from "@meguribi/core";
import { AgentErrorSchema } from "./agent-error.js";

const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

export const PermissionRequestSchema = v.strictObject({
  requestId: v.string(),
  sessionId: v.string(),
  operation: v.picklist(["file_read", "file_write", "command", "git_write", "production_deploy", "secret_access", "external_network", "unknown"]),
  tool: v.string(),
  summary: v.string(),
  targetPath: v.optional(v.string()),
  command: v.optional(v.string()),
  targetWithinWorktree: v.boolean(),
  protectedPath: v.boolean(),
  destructive: v.boolean(),
  network: v.boolean(),
  rawArtifactRef: v.optional(v.string()),
}) satisfies v.GenericSchema<unknown, CorePermissionRequest>;

export const ImplementationContextSchema = v.strictObject({
  issue: v.strictObject({ source: v.string(), content: v.string() }),
  comments: v.array(v.strictObject({ source: v.string(), content: v.string() })),
  acceptanceCriteria: v.array(v.string()),
  plan: v.strictObject({ summary: v.string(), steps: v.array(v.string()) }),
  repositoryRules: v.string(),
  primarySkill: v.string(),
  verificationCommands: v.array(v.string()),
  protectedPaths: v.array(v.string()),
  worktreePath: v.string(),
  allowedPaths: v.array(v.string()),
  limits: v.strictObject({ maxPromptChars: positiveInteger, maxChangedFiles: positiveInteger, maxDiffLines: positiveInteger }),
  expectedResult: v.array(v.string()),
  fixInstruction: v.optional(v.strictObject({ source: v.string(), content: v.string() })),
}) satisfies v.GenericSchema<unknown, CoreImplementationContext>;

export const AgentTerminationResultSchema = v.strictObject({
  reason: v.picklist(["completed", "cancelled", "timed_out", "crashed", "protocol_error"]),
  stopReason: v.optional(v.string()),
  stdinClosed: v.boolean(),
  cancelSent: v.boolean(),
  gracefulExit: v.boolean(),
  terminateSent: v.boolean(),
  forceKillUsed: v.boolean(),
  residualProcesses: v.pipe(v.number(), v.integer(), v.minValue(0)),
  cleanupError: v.optional(AgentErrorSchema),
}) satisfies v.GenericSchema<unknown, CoreAgentTerminationResult>;

export type PermissionRequest = v.InferOutput<typeof PermissionRequestSchema>;
export type ImplementationContext = v.InferOutput<typeof ImplementationContextSchema>;
export type AgentTerminationResult = v.InferOutput<typeof AgentTerminationResultSchema>;
