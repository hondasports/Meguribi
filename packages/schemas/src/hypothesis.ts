import * as v from "valibot";
import type {
  HypothesisArtifact as CoreHypothesisArtifact,
  HypothesisObservation as CoreHypothesisObservation,
  HypothesisProblemCandidate as CoreHypothesisProblemCandidate,
} from "@meguribi/core";

const confidence = v.picklist(["confirmed", "reported", "unknown"]);

export const HypothesisObservationSchema = v.strictObject({
  statement: v.string(),
  source: v.string(),
  confidence,
}) satisfies v.GenericSchema<unknown, CoreHypothesisObservation>;

export const HypothesisProblemCandidateSchema = v.strictObject({
  statement: v.string(),
  targetUser: v.optional(v.string()),
  confidence,
}) satisfies v.GenericSchema<unknown, CoreHypothesisProblemCandidate>;

export const HypothesisArtifactSchema = v.strictObject({
  schemaVersion: v.literal(1),
  artifactType: v.literal("hypothesis"),
  repository: v.string(),
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  generatedAt: v.pipe(v.string(), v.isoTimestamp()),
  status: v.literal("draft"),
  humanApprovalRequired: v.literal(true),
  observations: v.array(HypothesisObservationSchema),
  problemCandidates: v.array(HypothesisProblemCandidateSchema),
  causeHypotheses: v.array(v.string()),
  solutionHypotheses: v.array(v.string()),
  counterHypotheses: v.array(v.string()),
  validationMethods: v.array(v.string()),
  successConditions: v.array(v.string()),
  rejectionConditions: v.array(v.string()),
  missingEvidence: v.array(v.string()),
}) satisfies v.GenericSchema<unknown, CoreHypothesisArtifact>;
