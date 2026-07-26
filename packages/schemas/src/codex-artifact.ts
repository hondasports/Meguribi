import * as v from "valibot";
import type {
  CodexArtifactMetadata as CoreCodexArtifactMetadata,
  CodexEventRecord as CoreCodexEventRecord,
  PlanArtifact as CorePlanArtifact,
  PlanContent as CorePlanContent,
  ReviewArtifact as CoreReviewArtifact,
  ReviewContent as CoreReviewContent,
} from "@meguribi/core";

const nonNegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0));

export const CodexEventRecordSchema = v.strictObject({
  type: v.string(),
  at: v.pipe(v.string(), v.isoTimestamp()),
  data: v.record(v.string(), v.unknown()),
}) satisfies v.GenericSchema<unknown, CoreCodexEventRecord>;

export const CodexArtifactMetadataSchema = v.strictObject({
  schemaVersion: v.literal(1),
  artifactId: v.string(),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  durationMs: nonNegativeInteger,
  producer: v.strictObject({
    kind: v.literal("codex"),
    role: v.picklist(["planner", "reviewer"]),
    threadId: v.string(),
  }),
  sourceDigests: v.record(v.string(), v.string()),
  eventLog: v.array(CodexEventRecordSchema),
}) satisfies v.GenericSchema<unknown, CoreCodexArtifactMetadata>;

export const PlanContentSchema = v.strictObject({
  summary: v.string(),
  requirements: v.array(v.string()),
  acceptanceCriteria: v.array(v.string()),
  outOfScope: v.array(v.string()),
  proposedFiles: v.array(v.string()),
  steps: v.array(v.string()),
  risks: v.array(v.string()),
  tests: v.array(v.string()),
  humanDecisions: v.array(v.string()),
  unresolvedItems: v.array(v.string()),
}) satisfies v.GenericSchema<unknown, CorePlanContent>;

export const PlanArtifactSchema = v.strictObject({
  schemaVersion: v.literal(1),
  artifactType: v.literal("implementation-plan"),
  metadata: CodexArtifactMetadataSchema,
  summary: v.string(),
  requirements: v.array(v.string()),
  acceptanceCriteria: v.array(v.string()),
  outOfScope: v.array(v.string()),
  proposedFiles: v.array(v.string()),
  steps: v.array(v.string()),
  risks: v.array(v.string()),
  tests: v.array(v.string()),
  humanDecisions: v.array(v.string()),
  unresolvedItems: v.array(v.string()),
}) satisfies v.GenericSchema<unknown, CorePlanArtifact>;

export const ReviewContentSchema = v.strictObject({
  status: v.picklist(["approved", "approved_with_notes", "changes_required", "blocked"]),
  summary: v.string(),
  requirementCoverage: v.array(
    v.strictObject({
      requirementId: v.string(),
      status: v.picklist(["covered", "partial", "missing"]),
      evidence: v.array(v.string()),
    }),
  ),
  findings: v.array(
    v.strictObject({
      id: v.string(),
      severity: v.picklist(["critical", "high", "medium", "low", "info"]),
      path: v.optional(v.string()),
      line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      problem: v.string(),
      requiredChange: v.string(),
    }),
  ),
  missingTests: v.array(v.string()),
  scopeViolations: v.array(v.string()),
  recommendedAction: v.picklist(["proceed", "fix", "block"]),
}) satisfies v.GenericSchema<unknown, CoreReviewContent>;

export const ReviewArtifactSchema = v.strictObject({
  schemaVersion: v.literal(1),
  artifactType: v.literal("code-review"),
  metadata: CodexArtifactMetadataSchema,
  status: v.picklist(["approved", "approved_with_notes", "changes_required", "blocked"]),
  summary: v.string(),
  requirementCoverage: v.array(
    v.strictObject({
      requirementId: v.string(),
      status: v.picklist(["covered", "partial", "missing"]),
      evidence: v.array(v.string()),
    }),
  ),
  findings: v.array(
    v.strictObject({
      id: v.string(),
      severity: v.picklist(["critical", "high", "medium", "low", "info"]),
      path: v.optional(v.string()),
      line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      problem: v.string(),
      requiredChange: v.string(),
    }),
  ),
  missingTests: v.array(v.string()),
  scopeViolations: v.array(v.string()),
  recommendedAction: v.picklist(["proceed", "fix", "block"]),
}) satisfies v.GenericSchema<unknown, CoreReviewArtifact>;

export type CodexEventRecord = v.InferOutput<typeof CodexEventRecordSchema>;
export type CodexArtifactMetadata = v.InferOutput<typeof CodexArtifactMetadataSchema>;
export type PlanContent = v.InferOutput<typeof PlanContentSchema>;
export type PlanArtifact = v.InferOutput<typeof PlanArtifactSchema>;
export type ReviewContent = v.InferOutput<typeof ReviewContentSchema>;
export type ReviewArtifact = v.InferOutput<typeof ReviewArtifactSchema>;
