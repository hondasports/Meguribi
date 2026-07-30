import * as v from "valibot";
import type { MeasurementArtifact as CoreMeasurementArtifact } from "@meguribi/core";
export const MeasurementArtifactSchema = v.strictObject({
  schemaVersion: v.literal(1), artifactType: v.literal("measurement"), repository: v.string(), sourceIssueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)), sourceIssueUrl: v.string(), pullRequestNumber: v.pipe(v.number(), v.integer(), v.minValue(1)), pullRequestUrl: v.string(), generatedAt: v.pipe(v.string(), v.isoTimestamp()), humanApprovalRequired: v.literal(true), originalHypothesis: v.nullable(v.string()), period: v.strictObject({ from: v.string(), to: v.string() }), metrics: v.array(v.string()), qualitativeEvidence: v.array(v.string()), result: v.literal("inconclusive"), recommendedNextAction: v.literal("collect_more_data"), nextHypothesisCandidates: v.array(v.string()), openQuestions: v.array(v.string()),
}) satisfies v.GenericSchema<unknown, CoreMeasurementArtifact>;
