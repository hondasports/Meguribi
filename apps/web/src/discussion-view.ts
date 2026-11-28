import type { DiscussionConclusion, DiscussionEndReason, DiscussionTurn } from "@meguribi/core";

export interface ThreadNode {
  turn: DiscussionTurn;
  depth: number;
  children: ThreadNode[];
}

export interface TurnLink {
  id: string;
  exists: boolean;
}

export interface ConclusionView {
  conclusion: string;
  endedByLabel: string;
  issues: Array<{
    issue: string;
    positions: Array<{
      participant: string;
      stance: string;
      turnLinks: TurnLink[];
    }>;
    resolution: string;
  }>;
  rejected: Array<{
    option: string;
    reason: string;
    turnLinks: TurnLink[];
  }>;
  openQuestions: string[];
}

const MAX_THREAD_DEPTH = 3;

function setDepth(node: ThreadNode, depth: number): void {
  node.depth = Math.min(depth, MAX_THREAD_DEPTH);
  for (const child of node.children) {
    setDepth(child, depth + 1);
  }
}

export function buildThread(turns: readonly DiscussionTurn[]): ThreadNode[] {
  const nodes = turns.map((turn) => ({ turn, depth: 0, children: [] as ThreadNode[] }));
  const indexes = new Map(turns.map((turn, index) => [turn.turnId, index] as const));
  const roots: ThreadNode[] = [];

  nodes.forEach((node, index) => {
    const parentId = node.turn.envelope.replyTo[0];
    const parentIndex = parentId === undefined ? undefined : indexes.get(parentId);
    if (parentIndex !== undefined && parentIndex < index) {
      nodes[parentIndex]!.children.push(node);
    } else {
      roots.push(node);
    }
  });

  for (const root of roots) {
    setDepth(root, 0);
  }
  return roots;
}

function turnLinks(turnIds: readonly string[], existing: ReadonlySet<string>): TurnLink[] {
  return turnIds.map((id) => ({ id, exists: existing.has(id) }));
}

function endedByLabel(endedBy: DiscussionEndReason): string {
  switch (endedBy) {
    case "consensus":
      return "全員合意";
    case "max_turns":
      return "最大ターン到達";
    case "max_duration":
      return "時間切れ";
    case "timeout":
      return "応答なし";
  }
}

export function buildConclusionView(
  conclusion: DiscussionConclusion,
  turns: readonly DiscussionTurn[],
): ConclusionView {
  const existing = new Set(turns.map((turn) => turn.turnId));
  return {
    conclusion: conclusion.conclusion,
    endedByLabel: endedByLabel(conclusion.endedBy),
    issues: conclusion.issues.map((issue) => ({
      issue: issue.issue,
      positions: issue.positions.map((position) => ({
        participant: position.participant,
        stance: position.stance,
        turnLinks: turnLinks(position.turnIds, existing),
      })),
      resolution: issue.resolution,
    })),
    rejected: conclusion.rejectedOptions.map((option) => ({
      option: option.option,
      reason: option.reason,
      turnLinks: turnLinks(option.turnIds, existing),
    })),
    openQuestions: [...conclusion.openQuestions],
  };
}
