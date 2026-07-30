import * as v from "valibot";
import type { ProblemArtifact as CoreProblemArtifact } from "@meguribi/core";

export const ProblemArtifactSchema = v.strictObject({
  schemaVersion: v.literal(1),
  artifactType: v.literal("problem"),
  repository: v.string(),
  sourceIssueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  sourceIssueUrl: v.string(),
  generatedAt: v.pipe(v.string(), v.isoTimestamp()),
  status: v.literal("draft"),
  humanApprovalRequired: v.literal(true),
  title: v.string(),
  problem: v.string(),
  targetUser: v.nullable(v.string()),
  evidence: v.array(v.string()),
  userImpact: v.nullable(v.string()),
  currentWorkaround: v.nullable(v.string()),
  unconfirmedItems: v.array(v.string()),
  relatedHypothesis: v.string(),
}) satisfies v.GenericSchema<unknown, CoreProblemArtifact>;
