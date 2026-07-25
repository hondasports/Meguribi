import * as v from "valibot";
import type { AgentPrompt as CoreAgentPrompt } from "@meguribi/core";

export const AgentPromptSchema = v.object({
  content: v.string(),
  metadata: v.optional(v.record(v.string(), v.unknown())),
}) satisfies v.GenericSchema<unknown, CoreAgentPrompt>;

export type AgentPrompt = v.InferOutput<typeof AgentPromptSchema>;
