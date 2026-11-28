import { describe, expect, it } from "vitest";
import {
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
