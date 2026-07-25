import * as v from "valibot";
import type { AgentExecutionResult as CoreAgentExecutionResult } from "@meguribi/core";
import { AgentErrorSchema } from "./agent-error.js";

export const AgentExecutionResultSchema = v.object({
  status: v.picklist(["completed", "cancelled", "timed_out", "failed", "blocked"]),
  sessionId: v.string(),
  stopReason: v.optional(v.string()),
  summary: v.optional(v.string()),
  unresolvedItems: v.optional(v.array(v.string()), []),
  reportedFiles: v.optional(v.array(v.string())),
  error: v.optional(AgentErrorSchema),
}) satisfies v.GenericSchema<unknown, CoreAgentExecutionResult>;

export type AgentExecutionResult = v.InferOutput<typeof AgentExecutionResultSchema>;
