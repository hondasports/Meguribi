import { describe, expect, it } from "vitest";
import {
  agentDisplayName,
  validateRoleAssignments,
  type AgentProfile,
  type RoleAssignments,
} from "./role-agent.js";

const profiles: AgentProfile[] = [
  {
    id: "claude-code",
    kind: "claude-code",
    transport: "acp",
    executable: "claude-agent-acp",
    startupTimeoutMs: 10000,
    turnTimeoutMinutes: 45,
    inheritedMcpPolicy: "warn",
  },
  {
    id: "codex",
    kind: "codex",
    transport: "sdk",
    startupTimeoutMs: 10000,
    turnTimeoutMinutes: 45,
    inheritedMcpPolicy: "warn",
  },
  {
    id: "devin",
    kind: "devin",
    transport: "acp",
    startupTimeoutMs: 10000,
    turnTimeoutMinutes: 45,
    inheritedMcpPolicy: "warn",
  },
];
const base: RoleAssignments = {
  discussants: [],
  planner: "codex",
  reviewer: "codex",
  implementer: "devin",
  allowSameImplementerReviewer: false,
};

describe("validateRoleAssignments", () => {
  it("accepts the default assignment", () =>
    expect(() => validateRoleAssignments(base, profiles)).not.toThrow());
  it("rejects unknown profile ids", () =>
    expect(() => validateRoleAssignments({ ...base, reviewer: "gemini" }, profiles)).toThrow(
      expect.objectContaining({ code: "unknown_profile" }),
    ));
  it("rejects the same implementer and reviewer", () =>
    expect(() => validateRoleAssignments({ ...base, reviewer: "devin" }, profiles)).toThrow(
      expect.objectContaining({ code: "same_implementer_reviewer" }),
    ));
  it("allows the same implementer and reviewer when explicitly enabled", () =>
    expect(() =>
      validateRoleAssignments({ ...base, reviewer: "devin", allowSameImplementerReviewer: true }, profiles),
    ).not.toThrow());
  it("rejects an sdk-transport implementer", () =>
    expect(() =>
      validateRoleAssignments({ ...base, implementer: "codex", reviewer: "devin" }, profiles),
    ).toThrow(expect.objectContaining({ code: "transport_unsupported" })));
  it("rejects duplicate discussants", () =>
    expect(() => validateRoleAssignments({ ...base, discussants: ["devin", "devin"] }, profiles)).toThrow(
      expect.objectContaining({ code: "duplicate_discussant" }),
    ));
});

describe("agentDisplayName", () => {
  it("names agents for display", () => expect(agentDisplayName("claude-code")).toBe("Claude Code"));
});
