import { describe, expect, it } from "vitest";
import { evaluateMcpOutput, formatMcpSecurityAlert } from "./mcp.js";

describe("MCP detection and policy", () => {
  it("detects stdio and HTTP without preserving endpoint data", () => {
    expect(evaluateMcpOutput({ policy: "deny", mode: "non-interactive", explicitAllow: false, output: "starting MCP stdio server token=secret" }).outcome).toBe("block");
    expect(evaluateMcpOutput({ policy: "deny", mode: "non-interactive", explicitAllow: false, output: "connecting to MCP http endpoint https://private.example/a" }).outcome).toBe("block");
    expect(formatMcpSecurityAlert({ transport: "http://private.example", action: "blocked-and-terminated" })).not.toContain("private.example");
  });
});
