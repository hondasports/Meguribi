import { describe, expect, it } from "vitest";
import { createMcpPolicyMonitor, evaluateMcpOutput, formatMcpSecurityAlert } from "./mcp.js";

describe("MCP detection and policy", () => {
  it("detects stdio and HTTP without preserving endpoint data", () => {
    expect(evaluateMcpOutput({ policy: "deny", mode: "non-interactive", explicitAllow: false, output: "starting MCP stdio server token=secret" }).outcome).toBe("block");
    expect(evaluateMcpOutput({ policy: "deny", mode: "non-interactive", explicitAllow: false, output: "connecting to MCP http endpoint https://private.example/a" }).outcome).toBe("block");
    expect(formatMcpSecurityAlert({ transport: "http://private.example", action: "blocked-and-terminated" })).not.toContain("private.example");
  });

  it("does not treat a plain MCP discussion as a live connection", () => {
    expect(evaluateMcpOutput({
      policy: "deny",
      mode: "non-interactive",
      explicitAllow: false,
      output: "The plan mentions MCP as a future integration.",
    }).outcome).toBe("allow");
  });

  it("supports interactive confirmation with timeout-safe failure", async () => {
    const accepted = createMcpPolicyMonitor({
      policy: "warn",
      mode: "interactive",
      explicitAllow: false,
      confirm: () => true,
    });
    expect((await accepted.preflight()).outcome).toBe("allow");

    const rejected = createMcpPolicyMonitor({
      policy: "warn",
      mode: "interactive",
      explicitAllow: false,
      confirm: () => { throw new Error("unavailable"); },
    });
    expect((await rejected.preflight()).outcome).toBe("block");
  });
});
