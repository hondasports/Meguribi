import * as v from "valibot";
import type {
  AcpDiagnosis as CoreAcpDiagnosis,
  AgentDiagnosis as CoreAgentDiagnosis,
  AuthenticationDiagnosis as CoreAuthenticationDiagnosis,
  DiagnosisError as CoreDiagnosisError,
  DiagnosisErrorCode as CoreDiagnosisErrorCode,
  DiagnosisWarning as CoreDiagnosisWarning,
  DiagnosisWarningCode as CoreDiagnosisWarningCode,
  ExecutableDiagnosis as CoreExecutableDiagnosis,
  InheritedMcpPolicy as CoreInheritedMcpPolicy,
  VersionDiagnosis as CoreVersionDiagnosis,
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

export const ExecutableDiagnosisSchema = v.object({
  status: v.picklist(["ok", "missing"]),
  path: v.optional(v.string()),
}) satisfies v.GenericSchema<unknown, CoreExecutableDiagnosis>;

export const VersionDiagnosisSchema = v.object({
  status: v.picklist(["supported", "unsupported", "unknown"]),
  raw: v.optional(v.string()),
}) satisfies v.GenericSchema<unknown, CoreVersionDiagnosis>;

export const AuthenticationDiagnosisSchema = v.object({
  status: v.picklist(["authenticated", "unauthenticated", "unknown"]),
}) satisfies v.GenericSchema<unknown, CoreAuthenticationDiagnosis>;

export const AcpDiagnosisSchema = v.object({
  status: v.picklist(["supported", "unsupported", "unknown"]),
}) satisfies v.GenericSchema<unknown, CoreAcpDiagnosis>;

export const AgentDiagnosisSchema = v.object({
  executable: ExecutableDiagnosisSchema,
  version: VersionDiagnosisSchema,
  authentication: AuthenticationDiagnosisSchema,
  acp: AcpDiagnosisSchema,
  inheritedMcpPolicy: InheritedMcpPolicySchema,
  runnable: v.boolean(),
  warnings: v.array(DiagnosisWarningSchema),
  errors: v.array(DiagnosisErrorSchema),
}) satisfies v.GenericSchema<unknown, CoreAgentDiagnosis>;

export type InheritedMcpPolicy = v.InferOutput<typeof InheritedMcpPolicySchema>;
export type DiagnosisErrorCode = v.InferOutput<typeof DiagnosisErrorCodeSchema>;
export type DiagnosisError = v.InferOutput<typeof DiagnosisErrorSchema>;
export type DiagnosisWarningCode = v.InferOutput<typeof DiagnosisWarningCodeSchema>;
export type DiagnosisWarning = v.InferOutput<typeof DiagnosisWarningSchema>;
export type ExecutableDiagnosis = v.InferOutput<typeof ExecutableDiagnosisSchema>;
export type VersionDiagnosis = v.InferOutput<typeof VersionDiagnosisSchema>;
export type AuthenticationDiagnosis = v.InferOutput<typeof AuthenticationDiagnosisSchema>;
export type AcpDiagnosis = v.InferOutput<typeof AcpDiagnosisSchema>;
export type AgentDiagnosis = v.InferOutput<typeof AgentDiagnosisSchema>;
