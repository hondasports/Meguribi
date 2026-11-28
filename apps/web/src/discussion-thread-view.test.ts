import { describe, expect, it } from "vitest";
import {
  shouldAutoScrollAfterAppend,
  shouldStickToBottom,
  speakerVisual,
} from "./discussion-thread-view.js";

describe("speakerVisual", () => {
  it("identifies agents with stable initials and agent kind", () => {
    expect(speakerVisual("claude-code", "Claude Code")).toMatchObject({
      initials: "CC",
      kind: "agent",
      kindLabel: "Agent",
    });
    expect(speakerVisual("codex-acp", "Codex CLI").initials).toBe("CA");
  });

  it("identifies the human speaker distinctly", () => {
    expect(speakerVisual("human", "You")).toMatchObject({
      initials: "Y",
      kind: "human",
      kindLabel: "You",
    });
  });
});

describe("scroll anchoring", () => {
  it("sticks to bottom only inside the threshold", () => {
    expect(shouldStickToBottom({ scrollTop: 904, clientHeight: 500, scrollHeight: 1500 })).toBe(
      true,
    );
    expect(shouldStickToBottom({ scrollTop: 500, clientHeight: 500, scrollHeight: 1500 })).toBe(
      false,
    );
    expect(shouldStickToBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 400 })).toBe(true);
  });

  it("scrolls initial transcript loads and appends only when already pinned", () => {
    expect(shouldAutoScrollAfterAppend({ previousCount: 0, nextCount: 8, wasAtBottom: false })).toBe(
      true,
    );
    expect(shouldAutoScrollAfterAppend({ previousCount: 8, nextCount: 9, wasAtBottom: true })).toBe(
      true,
    );
    expect(shouldAutoScrollAfterAppend({ previousCount: 8, nextCount: 9, wasAtBottom: false })).toBe(
      false,
    );
    expect(shouldAutoScrollAfterAppend({ previousCount: 8, nextCount: 8, wasAtBottom: true })).toBe(
      false,
    );
  });
});
