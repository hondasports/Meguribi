/**
 * エージェントへ送信するプロンプト。
 * content は adapter が処理しやすい形式に変換する。
 */
export interface AgentPrompt {
  content: string;
  metadata?: Record<string, unknown>;
}
