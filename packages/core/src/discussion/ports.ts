import type { LiveLogEvent } from "../live-log.js";
import type { RoleAgent } from "../role-agent.js";
import type { DiscussionBrief } from "./prompt.js";
import type {
  DiscussionConclusion,
  DiscussionEndReason,
  DiscussionTurn,
} from "./types.js";

/**
 * 議論の記録を扱うストアの port。
 * adapters 側の FileSystemDiscussionStore が実装する。
 */
export interface DiscussionStorePort {
  appendTurn(turn: DiscussionTurn): Promise<void>;
  readTurns(): Promise<DiscussionTurn[]>;
  readHumanMessages(): Promise<{ message: string; at: string }[]>;
  saveConclusion(conclusion: DiscussionConclusion): Promise<void>;
  readConclusion(): Promise<DiscussionConclusion | null>;
}

/**
 * Run ID が確定してから、その Run 専用の store を作る factory。
 * CLI / wiring は FileSystemDiscussionStore へ実際の runId を渡すこと。
 */
export type DiscussionStoreFactory = (runId: string) => DiscussionStorePort;

/**
 * summarizer による議論要約の入力。
 * CLI / wiring は adapters の summarizeDiscussion に core の buildSummarizerPrompt を渡し、
 * この1引数の port として workflow へ注入する。
 */
export interface SummarizeDiscussionInput {
  summarizer: RoleAgent;
  cwd: string;
  artifactRoot: string;
  brief: DiscussionBrief;
  turns: readonly DiscussionTurn[];
  endedBy: DiscussionEndReason;
  abortSignal?: AbortSignal;
  onEvent?: (event: LiveLogEvent) => void;
}

export type SummarizeDiscussion = (
  input: SummarizeDiscussionInput,
) => Promise<DiscussionConclusion>;
