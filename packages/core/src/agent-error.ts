/**
 * 外部エージェント実行で発生するエラーの分類。
 * 生の SDK/CLI 固有の情報は含まない。
 */
export type AgentErrorCode =
  | "executable_not_found"
  | "unsupported_version"
  | "unauthenticated"
  | "protocol_initialization_failure"
  | "protocol_violation"
  | "malformed_message"
  | "permission_denied"
  | "timeout"
  | "cancelled"
  | "process_crashed"
  | "unsupported_signal"
  | "cleanup_failed"
  | "policy_blocked"
  | "unknown";

/**
 * 外部エージェント実行で発生したエラー。
 * セーフなメッセージのみを含む。
 */
export interface AgentError {
  code: AgentErrorCode;
  message: string;
  isRetryable: boolean;
}
