import type { AgentEvent } from "./agent-event.js";
import type { AgentPrompt } from "./agent-prompt.js";

/**
 * 外部エージェント（Codex / Devin）との1セッションを抽象化する。
 * vendor 固有の型を漏らさない最小限の interface。
 */
export interface AgentSession {
  readonly id: string;
  send(input: AgentPrompt): AsyncIterable<AgentEvent>;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
}
