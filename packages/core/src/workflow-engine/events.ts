import type { LiveLogEvent } from "../live-log.js";
import type { DiscussionEndReason, DiscussionTurn } from "../discussion/types.js";
import type { StepKind } from "./definition.js";
import type { StepOutcome, WorkflowRunResult } from "./engine.js";

/**
 * ワークフロー実行の通知イベント。
 * 進捗表示用であり、購読側の例外は結果に影響しない。
 */
export type WorkflowEvent =
  | LiveLogEvent
  | {
      type: "discussion.turn";
      runId: string;
      turn: DiscussionTurn;
      turnNumber: number;
      maxTurns: number;
    }
  | {
      type: "discussion.ended";
      runId: string;
      endedBy: DiscussionEndReason;
      turns: number;
      at: string;
    }
  | { type: "workflow.started"; runId: string; workflow: string; at: string }
  | {
      type: "workflow.step.started";
      runId: string;
      stepId: string;
      kind: StepKind;
      visit: number;
      at: string;
    }
  | {
      type: "workflow.step.completed";
      runId: string;
      stepId: string;
      kind: StepKind;
      outcome: StepOutcome["type"];
      at: string;
    }
  | {
      type: "workflow.step.failed";
      runId: string;
      stepId: string;
      kind: StepKind;
      message: string;
      at: string;
    }
  | {
      type: "workflow.finished";
      runId: string;
      workflow: string;
      outcome: WorkflowRunResult<unknown>["type"];
      at: string;
    };
