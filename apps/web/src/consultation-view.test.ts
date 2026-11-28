import { describe, expect, it } from "vitest";
import {
  consultationPromptForDisplay,
  consultationTitle,
  discussionMcpPolicyAfterSubmit,
  initialDiscussionMcpPolicy,
  isConsultationCommand,
} from "./consultation-view.js";

describe("consultationTitle", () => {
  it("uses the first meaningful prompt line instead of internal run identity", () => {
    expect(consultationTitle("\n通知を減らしたい\n詳細は後続")).toBe("通知を減らしたい");
  });

  it("truncates a long first line and falls back for empty input", () => {
    expect(consultationTitle(`${"a".repeat(90)} rest`)).toBe(`${"a".repeat(77)}...`);
    expect(consultationTitle("  \n")).toBe("相談");
  });
});


describe("consultationPromptForDisplay", () => {
  it("prefers the persisted discussion prompt without altering its contents", () => {
    expect(
      consultationPromptForDisplay({
        persistedPrompt: "  通知を減らしたい\n詳細も残す  ",
        localPrompt: "local fallback",
      }),
    ).toBe("  通知を減らしたい\n詳細も残す  ");
  });

  it("falls back to the locally submitted prompt only while the server prompt is unavailable", () => {
    expect(
      consultationPromptForDisplay({ persistedPrompt: undefined, localPrompt: "local prompt" }),
    ).toBe("local prompt");
    expect(consultationPromptForDisplay({ persistedPrompt: "   ", localPrompt: "local prompt" })).toBe(
      "local prompt",
    );
    expect(consultationPromptForDisplay({ persistedPrompt: undefined, localPrompt: undefined })).toBeNull();
  });
});

describe("isConsultationCommand", () => {
  it("treats consult as the primary contract and discuss as legacy issue-linked discussion", () => {
    expect(isConsultationCommand("consult")).toBe(true);
    expect(isConsultationCommand("discuss")).toBe(true);
    expect(isConsultationCommand("run")).toBe(false);
  });
});

describe("discussion MCP policy selection", () => {
  it("defaults to deny and resets to deny after every submit so retries do not inherit allow", () => {
    expect(initialDiscussionMcpPolicy()).toBe("deny");
    expect(discussionMcpPolicyAfterSubmit()).toBe("deny");
  });
});
