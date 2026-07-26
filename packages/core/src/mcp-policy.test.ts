import { describe, expect, it } from "vitest";
import { decideInheritedMcpPolicy } from "./mcp-policy.js";

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
