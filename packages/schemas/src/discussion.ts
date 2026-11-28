import * as v from "valibot";
import type {
  DiscussionConclusion as CoreDiscussionConclusion,
  DiscussionConclusionContent as CoreDiscussionConclusionContent,
  DiscussionEnvelope as CoreDiscussionEnvelope,
} from "@meguribi/core";

const readonlyStringArray = v.pipe(v.array(v.string()), v.readonly());

export const DiscussionEnvelopeSchema = v.strictObject({
  message: v.pipe(v.string(), v.minLength(1)),
  replyTo: v.optional(readonlyStringArray, []),
  addressTo: v.optional(readonlyStringArray, []),
  positions: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          issue: v.string(),
          stance: v.string(),
        }),
      ),
      v.readonly(),
    ),
    [],
  ),
  newIssues: v.optional(readonlyStringArray, []),
  done: v.optional(v.boolean(), false),
}) satisfies v.GenericSchema<unknown, CoreDiscussionEnvelope>;

const conclusionPositionSchema = v.strictObject({
  participant: v.string(),
  stance: v.string(),
  turnIds: readonlyStringArray,
});

const conclusionIssueSchema = v.strictObject({
  issue: v.string(),
  positions: v.pipe(v.array(conclusionPositionSchema), v.readonly()),
  resolution: v.string(),
});

const rejectedOptionSchema = v.strictObject({
  option: v.string(),
  reason: v.string(),
  turnIds: readonlyStringArray,
});

const conclusionContentEntries = {
  topic: v.string(),
  conclusion: v.string(),
  issues: v.pipe(v.array(conclusionIssueSchema), v.readonly()),
  rejectedOptions: v.pipe(v.array(rejectedOptionSchema), v.readonly()),
  openQuestions: readonlyStringArray,
  acceptanceCriteriaSeeds: readonlyStringArray,
};

export const DiscussionConclusionContentSchema = v.strictObject(
  conclusionContentEntries,
) satisfies v.GenericSchema<unknown, CoreDiscussionConclusionContent>;

export const DiscussionConclusionSchema = v.strictObject({
  ...conclusionContentEntries,
  endedBy: v.picklist(["consensus", "max_turns", "max_duration", "timeout"]),
  transcriptHash: v.string(),
}) satisfies v.GenericSchema<unknown, CoreDiscussionConclusion>;

export type DiscussionEnvelope = v.InferOutput<typeof DiscussionEnvelopeSchema>;
export type DiscussionConclusionContent = v.InferOutput<typeof DiscussionConclusionContentSchema>;
export type DiscussionConclusion = v.InferOutput<typeof DiscussionConclusionSchema>;
