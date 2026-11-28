export interface DiscussionEnvelope {
  message: string;
  replyTo: readonly string[];
  addressTo: readonly string[];
  positions: readonly {
    issue: string;
    stance: string;
  }[];
  newIssues: readonly string[];
  done: boolean;
}

export interface DiscussionTurn {
  turnId: string;
  speaker: string;
  speakerLabel: string;
  envelope: DiscussionEnvelope;
  malformed: boolean;
  at: string;
}

export interface DiscussionLimits {
  maxTurns: number;
  maxDurationMs: number;
  turnTimeoutMs: number;
}

export const DEFAULT_DISCUSSION_LIMITS: DiscussionLimits = {
  maxTurns: 20,
  maxDurationMs: 1_800_000,
  turnTimeoutMs: 300_000,
};

export type DiscussionEndReason = "consensus" | "max_turns" | "max_duration" | "timeout";

export interface DiscussionConclusionContent {
  topic: string;
  conclusion: string;
  issues: readonly {
    issue: string;
    positions: readonly {
      participant: string;
      stance: string;
      turnIds: readonly string[];
    }[];
    resolution: string;
  }[];
  rejectedOptions: readonly {
    option: string;
    reason: string;
    turnIds: readonly string[];
  }[];
  openQuestions: readonly string[];
  acceptanceCriteriaSeeds: readonly string[];
}

export interface DiscussionConclusion extends DiscussionConclusionContent {
  endedBy: DiscussionEndReason;
  transcriptHash: string;
}
