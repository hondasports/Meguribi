import { describe, expect, it } from "vitest";
import { assessMcpPolicy, classifyMcpDiagnostics } from "../src/mcp.js";

describe("MCP diagnostics", () => {
  it("normalizes connection diagnostics and redacts targets", () => {
    const observations = classifyMcpDiagnostics([
      "Connecting to MCP server fake-http (HTTP https://localhost:4321/mcp)",
      "Started MCP stdio server fake-stdio command=node --token=cog_test-value"
    ].join("\n"));

    expect(observations).toEqual([
      { name: "fake-http", transport: "http", target: "https://localhost:4321/mcp", action: "connecting" },
      { name: "fake-stdio", transport: "stdio", target: "command=node --token=<REDACTED>", action: "started" }
    ]);
  });

  it("fails closed for deny-all and permits only exact allowlist names", () => {
    const observation = { name: "github", transport: "http" as const, target: "https://example.invalid", action: "connecting" as const };
    expect(assessMcpPolicy("deny-all", [], [observation])).toEqual({ allowed: false, unexpected: [observation] });
    expect(assessMcpPolicy("allowlist", ["github"], [observation])).toEqual({ allowed: true, unexpected: [] });
    expect(assessMcpPolicy("allowlist", ["local"], [observation])).toEqual({ allowed: false, unexpected: [observation] });
  });

  it("does not treat a configuration-load diagnostic as a connection", () => {
    expect(classifyMcpDiagnostics("Loaded MCP configuration from isolated file")).toEqual([]);
  });
});
