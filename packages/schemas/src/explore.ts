import * as v from "valibot";
import type { ExploreArtifact as CoreExploreArtifact, SolutionOption as CoreSolutionOption } from "@meguribi/core";

const nullableString = v.nullable(v.string());
export const SolutionOptionSchema = v.strictObject({
  id: v.string(), statement: v.string(), userValue: nullableString, validationPower: nullableString,
  implementationCost: nullableString, operationalCost: nullableString, risk: nullableString,
  reversibility: nullableString, strategicFit: nullableString, measurementDifficulty: nullableString,
  guardrailRisk: nullableString,
}) satisfies v.GenericSchema<unknown, CoreSolutionOption>;
export const ExploreArtifactSchema = v.strictObject({
  schemaVersion: v.literal(1), artifactType: v.literal("solution-exploration"), repository: v.string(),
  sourceIssueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)), sourceIssueUrl: v.string(),
  generatedAt: v.pipe(v.string(), v.isoTimestamp()), status: v.literal("draft"), humanApprovalRequired: v.literal(true),
  options: v.array(SolutionOptionSchema), selectedOptionId: v.nullable(v.string()), missingEvidence: v.array(v.string()),
}) satisfies v.GenericSchema<unknown, CoreExploreArtifact>;
