/**
 * Devin-specific diagnosis aliases for backward compatibility.
 * The canonical types are in ./agent-diagnosis.js.
 */
export type {
  AcpDiagnosis as DevinAcpDiagnosis,
  AgentDiagnosis as DevinDiagnosis,
  AuthenticationDiagnosis as DevinAuthenticationDiagnosis,
  DiagnosisError,
  DiagnosisErrorCode,
  DiagnosisWarning,
  DiagnosisWarningCode,
  ExecutableDiagnosis as DevinExecutableDiagnosis,
  VersionDiagnosis as DevinVersionDiagnosis,
  InheritedMcpPolicy,
} from "./agent-diagnosis.js";
