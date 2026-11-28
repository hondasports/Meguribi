import { describe, expect, it } from "vitest";
import {
  participantToolbarSummary,
  shouldOpenOptionsForValidation,
} from "./consultation-composer-view.js";

describe("participantToolbarSummary", () => {
  const profiles = [
    { id: "claude-code", label: "Claude Code" },
    { id: "devin", label: "Devin CLI" },
  ];

  it("prompts first-time users to choose participants when none are selected", () => {
    expect(participantToolbarSummary([], profiles)).toBe("参加CLIを選ぶ");
  });

  it("shows selected product display names instead of count-only technical ids", () => {
    expect(participantToolbarSummary(["claude-code", "devin"], profiles)).toBe(
      "Claude Code・Devin CLI",
    );
  });
});

describe("shouldOpenOptionsForValidation", () => {
  it("opens the options only for participant-count errors", () => {
    expect(shouldOpenOptionsForValidation("参加エージェントを2〜4件選んでください")).toBe(true);
    expect(shouldOpenOptionsForValidation("相談内容を入力してください")).toBe(false);
    expect(shouldOpenOptionsForValidation(null)).toBe(false);
  });
});
