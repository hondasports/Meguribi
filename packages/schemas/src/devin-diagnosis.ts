import * as v from "valibot";
import type {
  DiagnosisError as CoreDiagnosisError,
  DiagnosisErrorCode as CoreDiagnosisErrorCode,
  DiagnosisWarning as CoreDiagnosisWarning,
  DiagnosisWarningCode as CoreDiagnosisWarningCode,
  DevinDiagnosis as CoreDevinDiagnosis,
  InheritedMcpPolicy as CoreInheritedMcpPolicy,
} from "@meguribi/core";
import { AgentErrorCodeSchema } from "./agent-error.js";

export const InheritedMcpPolicySchema = v.picklist([
  "allow",
  "warn",
  "deny",
]) satisfies v.GenericSchema<unknown, CoreInheritedMcpPolicy>;

export const DiagnosisErrorCodeSchema = v.union([
  AgentErrorCodeSchema,
  v.literal("capability_missing"),
]) satisfies v.GenericSchema<unknown, CoreDiagnosisErrorCode>;

export const DiagnosisErrorSchema = v.object({
  code: DiagnosisErrorCodeSchema,
  message: v.string(),
  nextAction: v.optional(v.string()),
}) satisfies v.GenericSchema<unknown, CoreDiagnosisError>;

export const DiagnosisWarningCodeSchema = v.picklist([
  "inherited_mcp",
  "unknown_version",
  "auth_unknown",
  "acp_unknown",
]) satisfies v.GenericSchema<unknown, CoreDiagnosisWarningCode>;

export const DiagnosisWarningSchema = v.object({
  code: DiagnosisWarningCodeSchema,
  message: v.string(),
}) satisfies v.GenericSchema<unknown, CoreDiagnosisWarning>;

export const DevinDiagnosisSchema = v.object({
  executable: v.object({
    status: v.picklist(["ok", "missing"]),
    path: v.optional(v.string()),
  }),
  version: v.object({
    status: v.picklist(["supported", "unsupported", "unknown"]),
    raw: v.optional(v.string()),
  }),
  authentication: v.object({
    status: v.picklist(["authenticated", "unauthenticated", "unknown"]),
  }),
  acp: v.object({
    status: v.picklist(["supported", "unsupported", "unknown"]),
  }),
  inheritedMcpPolicy: InheritedMcpPolicySchema,
  runnable: v.boolean(),
  warnings: v.array(DiagnosisWarningSchema),
  errors: v.array(DiagnosisErrorSchema),
}) satisfies v.GenericSchema<unknown, CoreDevinDiagnosis>;

export type InheritedMcpPolicy = v.InferOutput<typeof InheritedMcpPolicySchema>;
export type DiagnosisErrorCode = v.InferOutput<typeof DiagnosisErrorCodeSchema>;
export type DiagnosisError = v.InferOutput<typeof DiagnosisErrorSchema>;
export type DiagnosisWarningCode = v.InferOutput<typeof DiagnosisWarningCodeSchema>;
export type DiagnosisWarning = v.InferOutput<typeof DiagnosisWarningSchema>;
export type DevinDiagnosis = v.InferOutput<typeof DevinDiagnosisSchema>;
