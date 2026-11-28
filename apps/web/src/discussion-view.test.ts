import { describe, expect, it } from "vitest";
import type { DiscussionConclusion, DiscussionTurn } from "@meguribi/core";
import { buildConclusionView, buildThread } from "./discussion-view.js";

function turn(input: {
  turnId: string;
  speaker?: string;
  speakerLabel?: string;
  replyTo?: readonly string[];
  malformed?: boolean;
  at?: string;
}): DiscussionTurn {
  return {
    turnId: input.turnId,
    speaker: input.speaker ?? "claude",
    speakerLabel: input.speakerLabel ?? input.speaker ?? "Claude Code",
    envelope: {
      message: `${input.turnId} の発言`,
      replyTo: input.replyTo ?? [],
      addressTo: [],
      positions: [],
      newIssues: [],
      done: false,
    },
    malformed: input.malformed ?? false,
    at: input.at ?? "2026-11-28T12:00:00.000Z",
  };
}

function conclusion(input: Partial<DiscussionConclusion> = {}): DiscussionConclusion {
  return {
    topic: "通知改善",
    conclusion: "夜間通知を朝にまとめて送る",
    issues: [
      {
        issue: "タイミング",
        positions: [
          { participant: "Claude Code", stance: "まとめる", turnIds: ["t-3", "missing"] },
          { participant: "Codex", stance: "条件付き", turnIds: ["t-4"] },
        ],
        resolution: "朝にまとめる",
      },
    ],
    rejectedOptions: [
      {
        option: "通知量の上限",
        reason: "重要通知も落ちる",
        turnIds: ["t-6", "missing-rejected"],
      },
    ],
    openQuestions: ["休日の扱い"],
    acceptanceCriteriaSeeds: [],
    endedBy: "consensus",
    transcriptHash: "hash",
    ...input,
  };
}

describe("buildThread", () => {
  it("nests replies under the first replyTo turn in input order", () => {
    const roots = buildThread([
      turn({ turnId: "t-1", speakerLabel: "Claude Code" }),
      turn({ turnId: "t-2", speaker: "codex", speakerLabel: "Codex", replyTo: ["t-1"] }),
      turn({ turnId: "t-3", speaker: "devin", speakerLabel: "Devin", replyTo: ["t-2"] }),
      turn({ turnId: "t-4", speakerLabel: "Claude Code" }),
    ]);

    expect(roots.map((node) => node.turn.turnId)).toEqual(["t-1", "t-4"]);
    expect(roots[0]?.children[0]).toMatchObject({ depth: 1, turn: { turnId: "t-2" } });
    expect(roots[0]?.children[0]?.children[0]).toMatchObject({
      depth: 2,
      turn: { turnId: "t-3" },
    });
  });

  it("treats a turn as a root when its parent is missing", () => {
    const roots = buildThread([turn({ turnId: "t-1", replyTo: ["missing"] })]);

    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ depth: 0, turn: { turnId: "t-1" }, children: [] });
  });

  it("caps indentation depth at 3 while preserving deeper descendants", () => {
    const roots = buildThread([
      turn({ turnId: "t-1" }),
      turn({ turnId: "t-2", replyTo: ["t-1"] }),
      turn({ turnId: "t-3", replyTo: ["t-2"] }),
      turn({ turnId: "t-4", replyTo: ["t-3"] }),
      turn({ turnId: "t-5", replyTo: ["t-4"] }),
    ]);

    const t2 = roots[0]?.children[0];
    const t3 = t2?.children[0];
    const t4 = t3?.children[0];
    const t5 = t4?.children[0];
    expect([t2?.depth, t3?.depth, t4?.depth, t5?.depth]).toEqual([1, 2, 3, 3]);
    expect(t5?.turn.turnId).toBe("t-5");
  });
});

describe("buildConclusionView", () => {
  it("maps conclusion fields and marks missing turn links", () => {
    const view = buildConclusionView(conclusion(), [
      turn({ turnId: "t-3" }),
      turn({ turnId: "t-6" }),
    ]);

    expect(view.conclusion).toBe("夜間通知を朝にまとめて送る");
    expect(view.endedByLabel).toBe("全員合意");
    expect(view.issues[0]?.positions[0]?.turnLinks).toEqual([
      { id: "t-3", exists: true },
      { id: "missing", exists: false },
    ]);
    expect(view.rejected[0]?.turnLinks).toEqual([
      { id: "t-6", exists: true },
      { id: "missing-rejected", exists: false },
    ]);
    expect(view.openQuestions).toEqual(["休日の扱い"]);
  });

  it("maps every end reason to a Japanese label", () => {
    const expected = {
      consensus: "全員合意",
      max_turns: "最大ターン到達",
      max_duration: "時間切れ",
      timeout: "応答なし",
    } as const;

    for (const [endedBy, label] of Object.entries(expected)) {
      expect(
        buildConclusionView(conclusion({ endedBy: endedBy as DiscussionConclusion["endedBy"] }), [])
          .endedByLabel,
      ).toBe(label);
    }
  });
});
