import { describe, expect, it } from "vitest";
import { parseAcpCapability } from "./acp.js";

describe("parseAcpCapability", () => {
  it("recognizes supported from an acp usage line", () => {
    expect(
      parseAcpCapability({
        acpHelp: "Usage: cursor acp <command>",
        acpExitCode: 0,
      }),
    ).toBe("supported");
    expect(
      parseAcpCapability({
        acpHelp: "Usage: cursor-agent.exe acp <command>",
        acpExitCode: 0,
      }),
    ).toBe("supported");
    expect(
      parseAcpCapability({ acpHelp: "usage: agent acp", acpExitCode: 0 }),
    ).toBe("supported");
  });

  it("recognizes supported when acp help mentions stdio/initialize", () => {
    expect(
      parseAcpCapability({
        acpHelp: "Commands:\n  acp\nstdio agent client\ninitialize",
        acpExitCode: 0,
      }),
    ).toBe("supported");
    expect(
      parseAcpCapability({
        acpHelp: "Initialize ACP - Agent Client Protocol",
        acpExitCode: 0,
      }),
    ).toBe("supported");
  });

  it("reports unsupported for unknown/invalid command output", () => {
    expect(
      parseAcpCapability({
        acpHelp: "Unknown command: acp",
        acpExitCode: 1,
      }),
    ).toBe("unsupported");
    expect(
      parseAcpCapability({
        acpHelp: "invalid command",
        acpExitCode: 2,
      }),
    ).toBe("unsupported");
    expect(
      parseAcpCapability({
        acpHelp: "acp command not found",
        acpExitCode: 127,
      }),
    ).toBe("unsupported");
  });

  it("returns unknown on timeout", () => {
    expect(
      parseAcpCapability({
        acpHelp: "Usage: cursor acp",
        acpExitCode: 0,
        timedOut: true,
      }),
    ).toBe("unknown");
  });

  it("falls back to root help when acp help is inconclusive", () => {
    expect(
      parseAcpCapability({
        rootHelp: "Usage: cursor acp\nCommands:",
        rootHelpExitCode: 0,
        acpHelp: "acp",
        acpExitCode: 0,
      }),
    ).toBe("supported");
  });

  it("reports unsupported when acp is not mentioned anywhere", () => {
    expect(
      parseAcpCapability({
        acpHelp: "Some other help output",
        acpExitCode: 0,
      }),
    ).toBe("unsupported");
  });
});
