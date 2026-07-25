import { describe, expect, it } from "vitest";
import { diagnoseDevinCapabilities } from "../src/diagnose.js";

describe("Devin capability diagnosis", () => {
  it("does not treat a version string as proof of MCP isolation", () => {
    const result = diagnoseDevinCapabilities({
      cliVersion: "3000.2.17",
      rootHelp: "acp --config <PATH> --agent-config <FILE>",
      acpHelp: "Usage: devin acp",
      isolation: "unknown",
      authentication: "authenticated"
    });

    expect(result.acpSupported).toBe(true);
    expect(result.mcpIsolation).toBe("unknown");
    expect(result.devinAcpCandidate).toBe(false);
    expect(result.reason).toContain("isolation");
  });

  it("accepts ACP only when all security gates pass", () => {
    const result = diagnoseDevinCapabilities({
      cliVersion: "3000.2.17",
      rootHelp: "acp --config <PATH> --agent-config <FILE>",
      acpHelp: "Usage: devin acp",
      isolation: "isolated",
      authentication: "authenticated",
      unexpectedMcp: false,
      residualProcesses: false
    });

    expect(result.devinAcpCandidate).toBe(true);
    expect(result.reason).toBe("all security gates passed");
  });
});
