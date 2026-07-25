import * as v from "valibot";
import type { AgentEvent as CoreAgentEvent } from "@meguribi/core";
import { AgentErrorSchema } from "./agent-error.js";

const isoTimestamp = v.pipe(v.string(), v.isoTimestamp());

export const AgentEventSchema = v.variant("type", [
  v.object({
    type: v.literal("session.started"),
    sessionId: v.string(),
    at: isoTimestamp,
  }),
  v.object({
    type: v.literal("message.delta"),
    sessionId: v.string(),
    text: v.string(),
    at: isoTimestamp,
  }),
  v.object({
    type: v.literal("tool.started"),
    sessionId: v.string(),
    tool: v.string(),
    toolCallId: v.optional(v.string()),
    summary: v.optional(v.string()),
    at: isoTimestamp,
  }),
  v.object({
    type: v.literal("tool.completed"),
    sessionId: v.string(),
    tool: v.string(),
    toolCallId: v.optional(v.string()),
    exitCode: v.optional(v.pipe(v.number(), v.integer())),
    status: v.optional(v.string()),
    at: isoTimestamp,
  }),
  v.object({
    type: v.literal("file.changed"),
    sessionId: v.string(),
    path: v.string(),
    at: isoTimestamp,
  }),
  v.object({
    type: v.literal("approval.required"),
    sessionId: v.string(),
    requestId: v.string(),
    summary: v.string(),
    at: isoTimestamp,
  }),
  v.object({
    type: v.literal("turn.completed"),
    sessionId: v.string(),
    stopReason: v.optional(v.string()),
    at: isoTimestamp,
  }),
  v.object({
    type: v.literal("session.failed"),
    sessionId: v.string(),
    error: AgentErrorSchema,
    at: isoTimestamp,
  }),
  v.object({
    type: v.literal("unknown"),
    sessionId: v.string(),
    rawType: v.string(),
    at: isoTimestamp,
  }),
]) satisfies v.GenericSchema<unknown, CoreAgentEvent>;

export type AgentEvent = v.InferOutput<typeof AgentEventSchema>;
