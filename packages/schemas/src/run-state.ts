import * as v from "valibot";
import type {
  DeliveryStep as CoreDeliveryStep,
  RunState as CoreRunState,
  RunStatus as CoreRunStatus,
  VerificationResult as CoreVerificationResult,
} from "@meguribi/core";

export const RunStatusSchema = v.picklist([
  "created",
  "planning",
  "planned",
  "implementing",
  "verifying",
  "reviewing",
  "fixing",
  "publishing",
  "awaiting_human",
  "blocked",
  "failed",
  "cancelled",
  "interrupted",
  "timed_out",
]) satisfies v.GenericSchema<unknown, CoreRunStatus>;

export const DeliveryStepSchema = v.picklist([
  "context",
  "preflight",
  "awaiting_mcp_confirmation",
  "worktree",
  "planning",
  "implementing",
  "implementation_completed",
  "implementation_blocked",
  "cancelling",
  "cancelled",
  "timed_out",
  "verifying",
  "reviewing",
  "fixing",
  "publishing",
  "awaiting_human",
]) satisfies v.GenericSchema<unknown, CoreDeliveryStep>;

export const RunStateSchema = v.strictObject({
  schemaVersion: v.literal(1),
  runId: v.string(),
  repository: v.string(),
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  command: v.picklist(["run", "resume"]),
  status: RunStatusSchema,
  currentStep: v.optional(DeliveryStepSchema),
  completedSteps: v.array(DeliveryStepSchema),
  branch: v.string(),
  worktreePath: v.string(),
  baseRef: v.string(),
  baseSha: v.string(),
  headSha: v.string(),
  remoteIdentity: v.string(),
  pullRequestNumber: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  agentSessions: v.strictObject({
    codexPlan: v.optional(v.string()),
    devinImplementation: v.optional(v.string()),
    codexReview: v.optional(v.string()),
  }),
  fixAttempts: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxFixAttempts: v.pipe(v.number(), v.integer(), v.minValue(0)),
  createdAt: v.string(),
  updatedAt: v.string(),
  lastError: v.optional(
    v.strictObject({
      code: v.string(),
      message: v.string(),
    }),
  ),
}) satisfies v.GenericSchema<unknown, CoreRunState>;

export const VerificationResultSchema = v.strictObject({
  schemaVersion: v.literal(1),
  artifactType: v.literal("verification"),
  success: v.boolean(),
  commands: v.array(
    v.strictObject({
      name: v.string(),
      exitCode: v.nullable(v.number()),
      startedAt: v.string(),
      finishedAt: v.string(),
      logPath: v.optional(v.string()),
    }),
  ),
}) satisfies v.GenericSchema<unknown, CoreVerificationResult>;

export type RunState = v.InferOutput<typeof RunStateSchema>;
export type RunStatus = v.InferOutput<typeof RunStatusSchema>;
export type DeliveryStep = v.InferOutput<typeof DeliveryStepSchema>;
export type VerificationResult = v.InferOutput<typeof VerificationResultSchema>;
