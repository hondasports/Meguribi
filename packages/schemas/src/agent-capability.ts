import * as v from "valibot";
import type { AgentCapability as CoreAgentCapability } from "@meguribi/core";

export const AgentCapabilitySchema = v.object({
  protocol: v.optional(v.string()),
  protocolVersion: v.optional(v.string()),
  agentName: v.optional(v.string()),
  agentVersion: v.optional(v.string()),
}) satisfies v.GenericSchema<unknown, CoreAgentCapability>;

export type AgentCapability = v.InferOutput<typeof AgentCapabilitySchema>;
