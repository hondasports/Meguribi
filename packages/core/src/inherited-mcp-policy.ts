/**
 * Devin CLI が利用者の保存済み MCP 設定を継承する可能性の扱い。
 * `@meguribi/config` の DevinConfig と同じ語彙を core でも共有する。
 */
export type InheritedMcpPolicy = "allow" | "warn" | "deny";

/**
 * 議論 Run ごとに利用者が明示する MCP 継承方針。
 * `warn` は曖昧な既定値なので、Run ごとの選択肢には含めない。
 */
export type DiscussionMcpPolicy = "allow" | "deny";
