import { describe, expect, it } from "vitest";
import { detectMcpConnection, evaluateMcpOutput } from "./mcp.js";

describe("acp detectMcpConnection false-positive hardening", () => {
  it("ignores only Meguribi's exact own metadata lines", () => {
    expect(detectMcpConnection("WARN: The agent may inherit saved MCP configuration; complete isolation is not guaranteed.").detected).toBe(false);
    expect(detectMcpConnection("SECURITY_ALERT: unexpected-mcp-connection").detected).toBe(false);
  });

  it("still fires on other WARN lines reporting genuine connections", () => {
    expect(detectMcpConnection("WARN: connected to MCP server https://x.example").detected).toBe(true);
  });

  it("ignores startup flags and isolation config path noise", () => {
    expect(detectMcpConnection("INFO acp_startup{pre_init_ms=7}: unleash flags evaluated: cli-bash-mode-smart=false cli-mcp-registry-fetch=true").detected).toBe(false);
    expect(detectMcpConnection("INFO config_importers: Configuration saved to /tmp/meguribi-devin-mcp-isolation-x/devin/config.json").detected).toBe(false);
  });

  it("mixed buffer: a benign first line never cancels a later genuine positive", () => {
    const mixed = [
      "INFO no MCP servers loaded at startup",
      "INFO acp_startup flags evaluated cli-mcp-registry=true",
      "starting MCP stdio server token=secret",
    ].join("\n");
    expect(evaluateMcpOutput({ policy: "deny", mode: "non-interactive", explicitAllow: false, output: mixed }).outcome).toBe("block");
  });

  it("mixed buffer: a positive first line is not hidden by later benign noise", () => {
    const mixed = [
      "connecting to MCP http endpoint https://private.example/a",
      "INFO no MCP servers loaded at startup",
    ].join("\n");
    expect(evaluateMcpOutput({ policy: "deny", mode: "non-interactive", explicitAllow: false, output: mixed }).outcome).toBe("block");
  });

  it("long-form Model Context Protocol mentions are evaluated", () => {
    expect(detectMcpConnection("connecting to Model Context Protocol server https://x.example").detected).toBe(true);
    expect(detectMcpConnection("the spec of Model Context Protocol is discussed").detected).toBe(false);
  });

  it("direct stdio/server/endpoint evidence stays protected", () => {
    expect(detectMcpConnection("starting MCP stdio server token=secret").transport).toBe("stdio");
    expect(detectMcpConnection("connecting to MCP http endpoint https://x.example").transport).toBe("http");
  });

  it("split mention across lines without per-line evidence does not fire", () => {
    const split = ["INFO mcp", "server noise without mention"].join("\n");
    expect(detectMcpConnection(split).detected).toBe(false);
  });

  it("keeps existing positive detection for stdio and http", () => {
    expect(evaluateMcpOutput({ policy: "deny", mode: "non-interactive", explicitAllow: false, output: "starting MCP stdio server token=secret" }).outcome).toBe("block");
    expect(evaluateMcpOutput({ policy: "deny", mode: "non-interactive", explicitAllow: false, output: "connecting to MCP http endpoint https://private.example/a" }).outcome).toBe("block");
  });
});
