/**
 * Devin-specific aliases for the agent-diagnosis schemas.
 * New code should import from ./agent-diagnosis.js.
 */
export {
  AcpDiagnosisSchema as DevinAcpDiagnosisSchema,
  AgentDiagnosisSchema as DevinDiagnosisSchema,
  AuthenticationDiagnosisSchema as DevinAuthenticationDiagnosisSchema,
  DiagnosisErrorCodeSchema,
  DiagnosisErrorSchema,
  DiagnosisWarningCodeSchema,
  DiagnosisWarningSchema,
  ExecutableDiagnosisSchema as DevinExecutableDiagnosisSchema,
  InheritedMcpPolicySchema,
  VersionDiagnosisSchema as DevinVersionDiagnosisSchema,
} from "./agent-diagnosis.js";
export type {
  AcpDiagnosis as DevinAcpDiagnosis,
  AgentDiagnosis as DevinDiagnosis,
  AuthenticationDiagnosis as DevinAuthenticationDiagnosis,
  DiagnosisError,
  DiagnosisErrorCode,
  DiagnosisWarning,
  DiagnosisWarningCode,
  ExecutableDiagnosis as DevinExecutableDiagnosis,
  InheritedMcpPolicy,
  VersionDiagnosis as DevinVersionDiagnosis,
} from "./agent-diagnosis.js";
