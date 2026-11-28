import { describe, expect, it } from "vitest";
import { decideInheritedMcpPolicy, resolveDiscussionMcpPolicy } from "./mcp-policy.js";

describe("decideInheritedMcpPolicy", () => {
  it("requires confirmation for warn in interactive mode", () => {
    expect(decideInheritedMcpPolicy({
      policy: "warn",
      mode: "interactive",
      explicitAllow: false,
      detection: { detected: false, transport: "unknown" },
    }).outcome).toBe("confirm");
  });

  it("blocks warn in non-interactive mode and detected MCP under deny", () => {
    expect(decideInheritedMcpPolicy({
      policy: "warn",
      mode: "non-interactive",
      explicitAllow: false,
      detection: { detected: false, transport: "unknown" },
    }).outcome).toBe("block");
    expect(decideInheritedMcpPolicy({
      policy: "deny",
      mode: "non-interactive",
      explicitAllow: false,
      detection: { detected: true, transport: "stdio" },
    }).outcome).toBe("block");
  });
});

describe("resolveDiscussionMcpPolicy", () => {
  it.each([
    { configured: ["warn"], discussionMcpPolicy: "allow", expected: "allow" },
    { configured: ["warn"], discussionMcpPolicy: "deny", expected: "deny" },
    { configured: ["allow"], discussionMcpPolicy: "deny", expected: "deny" },
    { configured: ["deny"], discussionMcpPolicy: "allow", expected: "deny" },
    { configured: ["allow", "warn"], discussionMcpPolicy: "allow", expected: "allow" },
    { configured: ["allow", "deny"], discussionMcpPolicy: "allow", expected: "deny" },
  ] as const)(
    "keeps explicit deny dominant and resolves only warn/allow ambiguity ($configured + $discussionMcpPolicy)",
    ({ configured, discussionMcpPolicy, expected }) => {
      expect(resolveDiscussionMcpPolicy({ configured, discussionMcpPolicy })).toBe(expected);
    },
  );
});
