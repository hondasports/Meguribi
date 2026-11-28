import type { LiveLogEvent } from "../live-log.js";
import type { RoleAgent } from "../role-agent.js";
import type {
  DiscussionConclusion,
  DiscussionEndReason,
  DiscussionTurn,
} from "./types.js";

// Task 3 の DiscussionBrief と同じ形。統合時に置き換える
interface DiscussionBrief {
  runId: string;
  topic: string;
  issueBody: string;
  comments: readonly string[];
  userRequest?: string;
  repositoryRules: string;
  participants: readonly { id: string; label: string }[];
  redoNotes: readonly string[];
}

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
 * summarizer による議論要約の入力。
 * prompt builder は Task 3 統合時に adapters 側へ注入する。
 */
export interface SummarizeDiscussionInput {
  summarizer: RoleAgent;
  cwd: string;
  artifactRoot: string;
  brief: DiscussionBrief;
  turns: readonly DiscussionTurn[];
  endedBy: DiscussionEndReason;
  onEvent?: (event: LiveLogEvent) => void;
}
