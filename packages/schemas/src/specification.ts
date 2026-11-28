import type {
  Specification as CoreSpecification,
  SpecificationContent as CoreSpecificationContent,
} from "@meguribi/core";
import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.regex(/\S/));
const stringArray = v.array(nonEmptyString);

const RequirementSchema = v.strictObject({
  id: nonEmptyString,
  statement: nonEmptyString,
  priority: v.picklist(["must", "should", "could"]),
});

const AcceptanceCriterionSchema = v.strictObject({
  id: nonEmptyString,
  seed: nonEmptyString,
  given: nonEmptyString,
  when: nonEmptyString,
  // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then の `then` はデータフィールドであり thenable ではない
  then: nonEmptyString,
  requirementIds: stringArray,
});

export const SpecificationContentSchema = v.strictObject({
  problem: v.nullable(nonEmptyString),
  targetUsers: stringArray,
  requirements: v.array(RequirementSchema),
  acceptanceCriteria: v.array(AcceptanceCriterionSchema),
  inScope: stringArray,
  outOfScope: stringArray,
  testPlan: stringArray,
  successMetrics: stringArray,
  guardrails: stringArray,
  openQuestions: stringArray,
}) satisfies v.GenericSchema<unknown, CoreSpecificationContent>;

export const SpecificationArtifactSchema = v.strictObject({
  schemaVersion: v.literal(1),
  artifactType: v.literal("specification"),
  repository: nonEmptyString,
  sourceIssueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  sourceIssueUrl: nonEmptyString,
  runId: nonEmptyString,
  conclusionHash: nonEmptyString,
  generatedAt: v.pipe(v.string(), v.isoTimestamp()),
  status: v.literal("draft"),
  humanApprovalRequired: v.literal(true),
  acceptanceCriteria: v.array(AcceptanceCriterionSchema),
  inScope: stringArray,
  outOfScope: stringArray,
  testPlan: stringArray,
  openQuestions: stringArray,
}) satisfies v.GenericSchema<unknown, CoreSpecification>;
