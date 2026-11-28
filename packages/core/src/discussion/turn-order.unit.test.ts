import { describe, expect, it } from "vitest";
import { evaluateDiscussionEnd, pickNextSpeaker, type DiscussionProgress } from "./turn-order.js";
import type { DiscussionEnvelope, DiscussionLimits, DiscussionTurn } from "./types.js";

const participants = ["claude", "codex", "devin"] as const;
const startedAt = "2026-11-28T00:00:00.000Z";
const baseTime = Date.parse(startedAt);

function envelope(overrides: Partial<DiscussionEnvelope> = {}): DiscussionEnvelope {
  return {
    message: "message",
    replyTo: [],
    addressTo: [],
    positions: [],
    newIssues: [],
    done: false,
    ...overrides,
  };
}

function turn(
  turnId: string,
  speaker: string,
  options: {
    addressTo?: readonly string[];
    done?: boolean;
    atOffsetMs?: number;
  } = {},
): DiscussionTurn {
  return {
    turnId,
    speaker,
    speakerLabel: speaker === "human" ? "あなた" : speaker,
    envelope: envelope({
      addressTo: options.addressTo ?? [],
      done: options.done ?? false,
    }),
    malformed: false,
    at: new Date(baseTime + (options.atOffsetMs ?? 0)).toISOString(),
  };
}

function progress(
  turns: readonly DiscussionTurn[],
  overrides: Partial<DiscussionProgress> = {},
): DiscussionProgress {
  return {
    participants,
    turns,
    startedAt,
    consecutiveTimeouts: {},
    ...overrides,
  };
}

function limits(overrides: Partial<DiscussionLimits> = {}): DiscussionLimits {
  return {
    maxTurns: 20,
    maxDurationMs: 1_800_000,
    turnTimeoutMs: 300_000,
    ...overrides,
  };
}

function now(offsetMs = 1_000): Date {
  return new Date(baseTime + offsetMs);
}

describe("pickNextSpeaker", () => {
  it("uses the configured order during the initial round", () => {
    expect(pickNextSpeaker(progress([]))).toBe("claude");
    expect(pickNextSpeaker(progress([turn("t-1", "claude")]))).toBe("codex");
    expect(pickNextSpeaker(progress([turn("t-1", "claude"), turn("t-2", "codex")]))).toBe("devin");
  });

  it("prefers the first addressed participant other than the previous speaker", () => {
    const turns = [
      turn("t-1", "claude"),
      turn("t-2", "codex"),
      turn("t-3", "devin"),
      turn("t-4", "claude", { addressTo: ["devin", "codex"] }),
    ];

    expect(pickNextSpeaker(progress(turns))).toBe("devin");
  });

  it("does not select the previous speaker even when they address themselves", () => {
    const turns = [
      turn("t-1", "claude"),
      turn("t-2", "codex"),
      turn("t-3", "devin"),
      turn("t-4", "claude", { addressTo: ["claude", "codex"] }),
    ];

    expect(pickNextSpeaker(progress(turns))).toBe("codex");
  });

  it("falls back to the participant whose latest turn is oldest", () => {
    const turns = [
      turn("t-1", "claude"),
      turn("t-2", "codex"),
      turn("t-3", "devin"),
      turn("t-4", "claude"),
      turn("t-5", "codex"),
    ];

    expect(pickNextSpeaker(progress(turns))).toBe("devin");
  });

  it("ignores human turns when determining the previous speaker and addressTo", () => {
    const turns = [
      turn("t-1", "claude"),
      turn("t-2", "codex"),
      turn("t-3", "devin"),
      turn("t-4", "claude", { addressTo: ["devin"] }),
      turn("t-5", "human"),
    ];

    expect(pickNextSpeaker(progress(turns))).toBe("devin");
  });
});

describe("evaluateDiscussionEnd", () => {
  it("returns consensus when every participant's latest envelope is done", () => {
    const turns = [
      turn("t-1", "claude", { done: true }),
      turn("t-2", "codex", { done: true }),
      turn("t-3", "devin", { done: true }),
    ];

    expect(evaluateDiscussionEnd(progress(turns), limits(), now())).toBe("consensus");
  });

  it("does not return consensus when a human speaks after every participant is done", () => {
    const turns = [
      turn("t-1", "claude", { done: true }),
      turn("t-2", "codex", { done: true }),
      turn("t-3", "devin", { done: true }),
      turn("t-4", "human"),
    ];

    expect(evaluateDiscussionEnd(progress(turns), limits(), now())).toBeUndefined();
  });

  it("allows consensus when a human spoke before the final participant finished", () => {
    const turns = [
      turn("t-1", "claude", { done: true }),
      turn("t-2", "human"),
      turn("t-3", "codex", { done: true }),
      turn("t-4", "devin", { done: true }),
    ];

    expect(evaluateDiscussionEnd(progress(turns), limits(), now())).toBe("consensus");
  });

  it("returns undefined while any participant is missing or not done", () => {
    const missing = [turn("t-1", "claude", { done: true }), turn("t-2", "codex", { done: true })];
    expect(evaluateDiscussionEnd(progress(missing), limits(), now())).toBeUndefined();

    const notDone = [
      turn("t-1", "claude", { done: true }),
      turn("t-2", "codex", { done: true }),
      turn("t-3", "devin"),
    ];
    expect(evaluateDiscussionEnd(progress(notDone), limits(), now())).toBeUndefined();
  });

  it("returns max_turns at exactly maxTurns agent turns without counting human turns", () => {
    const turns = [
      turn("t-1", "claude"),
      turn("t-2", "human"),
      turn("t-3", "codex"),
      turn("t-4", "devin"),
    ];

    expect(evaluateDiscussionEnd(progress(turns), limits({ maxTurns: 3 }), now())).toBe(
      "max_turns",
    );
    expect(evaluateDiscussionEnd(progress(turns), limits({ maxTurns: 4 }), now())).toBeUndefined();
  });

  it("returns timeout before other end reasons when a participant times out twice in a row", () => {
    const turns = [turn("t-1", "claude"), turn("t-2", "codex"), turn("t-3", "devin")];
    const state = progress(turns, { consecutiveTimeouts: { codex: 2 } });

    expect(evaluateDiscussionEnd(state, limits({ maxTurns: 3, maxDurationMs: 0 }), now())).toBe(
      "timeout",
    );
  });

  it("returns max_duration when the elapsed time reaches maxDurationMs", () => {
    const state = progress([]);

    expect(
      evaluateDiscussionEnd(state, limits({ maxDurationMs: 5_000 }), now(4_999)),
    ).toBeUndefined();
    expect(evaluateDiscussionEnd(state, limits({ maxDurationMs: 5_000 }), now(5_000))).toBe(
      "max_duration",
    );
  });
});
