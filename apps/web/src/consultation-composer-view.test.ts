import { describe, expect, it } from "vitest";
import {
  availableDefaultProfileIds,
  isProfileAvailable,
  participantAvailabilityError,
  participantToolbarSummary,
  shouldOpenOptionsForValidation,
} from "./consultation-composer-view.js";

describe("participantToolbarSummary", () => {
  const profiles = [
    { id: "claude-code", label: "Claude Code", available: true },
    { id: "devin", label: "Devin CLI", available: true },
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

describe("participant availability", () => {
  const profiles = [
    { id: "claude-code", label: "Claude Code", available: true },
    { id: "codex-acp", label: "Codex CLI", available: true },
    {
      id: "devin",
      label: "Devin CLI",
      available: false,
      unavailableReason: "CLIが見つかりません",
    },
  ];

  it("filters unavailable profiles out of initial selections", () => {
    expect(availableDefaultProfileIds(["claude-code", "devin", "unknown"], profiles)).toEqual([
      "claude-code",
    ]);
  });

  it("treats only explicitly available profiles as selectable", () => {
    expect(isProfileAvailable(profiles[0])).toBe(true);
    expect(isProfileAvailable(profiles[2])).toBe(false);
  });

  it("explains when fewer than two available profiles remain", () => {
    expect(participantAvailabilityError(profiles.slice(0, 2), null)).toBeNull();
    expect(participantAvailabilityError([profiles[0]!], null)).toBe(
      "利用可能な参加CLIが2件未満のため相談を開始できません（現在1件）。CLI設定を確認してください。",
    );
  });

  it("explains profile fetch failure outside the collapsed options", () => {
    expect(participantAvailabilityError([], "network error")).toBe(
      "参加CLI候補を取得できませんでした。network error",
    );
  });
});
