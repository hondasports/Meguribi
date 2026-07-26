/**
 * Devin CLI が利用者の保存済み MCP 設定を継承する可能性の扱い。
 * `@meguribi/config` の DevinConfig と同じ語彙を core でも共有する。
 */
export type InheritedMcpPolicy = "allow" | "warn" | "deny";
