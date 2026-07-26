import type { AgentErrorCode } from "./agent-error.js";
import type { InheritedMcpPolicy } from "./inherited-mcp-policy.js";

/**
 * エージェント CLI 診断で使うエラーコード。
 * AgentErrorCode に加え、ACP capability 欠如を区別する。
 */
export type DiagnosisErrorCode = AgentErrorCode | "capability_missing";

export interface DiagnosisError {
  code: DiagnosisErrorCode;
  message: string;
  /** 利用者が次に実行すべきコマンドや設定変更の案内 */
  nextAction?: string;
}

export type DiagnosisWarningCode =
  | "inherited_mcp"
  | "unknown_version"
  | "auth_unknown"
  | "acp_unknown";

export interface DiagnosisWarning {
  code: DiagnosisWarningCode;
  message: string;
}

export interface ExecutableDiagnosis {
  status: "ok" | "missing";
  path?: string;
}

export interface VersionDiagnosis {
  status: "supported" | "unsupported" | "unknown";
  raw?: string;
}

export interface AuthenticationDiagnosis {
  status: "authenticated" | "unauthenticated" | "unknown";
}

export interface AcpDiagnosis {
  status: "supported" | "unsupported" | "unknown";
}

/**
 * エージェント CLI の実行前診断結果。
 * secret・token・MCP URL などの生値を含めてはならない。
 */
export interface AgentDiagnosis {
  executable: ExecutableDiagnosis;
  version: VersionDiagnosis;
  authentication: AuthenticationDiagnosis;
  acp: AcpDiagnosis;
  inheritedMcpPolicy: InheritedMcpPolicy;
  runnable: boolean;
  warnings: DiagnosisWarning[];
  errors: DiagnosisError[];
}

export type { InheritedMcpPolicy };
