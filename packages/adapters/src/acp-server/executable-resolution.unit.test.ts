import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@meguribi/core";
import {
  resolveAcpServerExecutable,
  resolveAcpServerMainCli,
} from "./executable-resolution.js";

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function profile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: "custom",
    kind: "claude-code",
    transport: "acp",
    startupTimeoutMs: 1_000,
    turnTimeoutMinutes: 5,
    inheritedMcpPolicy: "allow",
    ...overrides,
  };
}

describe("resolveAcpServerExecutable", () => {
  it("resolves the bundled Claude bridge for the built-in profile without requiring a global bridge install", () => {
    const resolved = resolveAcpServerExecutable(
      profile({ id: "claude-code", executable: "claude-agent-acp" }),
    );

    expect(resolved.source).toBe("bundled");
    expect(resolved.executable).toBe(process.execPath);
    expect(resolved.executableArgs).toHaveLength(1);
    expect(normalizedPath(resolved.executableArgs[0] ?? "")).toContain("@agentclientprotocol/claude-agent-acp");
    expect(normalizedPath(resolved.executableArgs[0] ?? "")).toMatch(/dist\/index\.js$/);
    expect(existsSync(resolved.executableArgs[0] ?? "")).toBe(true);
  });

  it("resolves the bundled Codex ACP bridge for the built-in codex-acp profile", () => {
    const resolved = resolveAcpServerExecutable(
      profile({ id: "codex-acp", kind: "codex", executable: "codex-acp" }),
    );

    expect(resolved.source).toBe("bundled");
    expect(resolved.executable).toBe(process.execPath);
    expect(normalizedPath(resolved.executableArgs[0] ?? "")).toContain("@agentclientprotocol/codex-acp");
    expect(existsSync(resolved.executableArgs[0] ?? "")).toBe(true);
  });

  it("keeps an explicitly configured executable ahead of the bundled bridge", () => {
    const resolved = resolveAcpServerExecutable(
      profile({ id: "claude-code", executable: "/opt/custom/claude-acp" }),
    );

    expect(resolved).toEqual({
      executable: "/opt/custom/claude-acp",
      executableArgs: [],
      source: "configured",
    });
  });

  it("does not use the bundled bridge for a custom profile id without an executable", () => {
    const resolved = resolveAcpServerExecutable(profile({ id: "my-claude" }));

    expect(resolved).toEqual({
      executable: "my-claude",
      executableArgs: [],
      source: "profile",
    });
  });
});

describe("resolveAcpServerMainCli", () => {
  it("prefers the installed claude CLI for the standard Claude bridge", () => {
    expect(resolveAcpServerMainCli(profile({ id: "claude-code", executable: "claude-agent-acp" }), {})).toEqual({
      executable: "claude",
      executableArgs: [],
      versionArgs: ["--version"],
      authArgs: ["auth", "status"],
      authFormat: "claude-json",
      executableEnvVar: "CLAUDE_CODE_EXECUTABLE",
    });
  });

  it("prefers the installed codex CLI for the standard Codex bridge", () => {
    expect(resolveAcpServerMainCli(profile({ id: "codex-acp", kind: "codex", executable: "codex-acp" }), {})).toEqual({
      executable: "codex",
      executableArgs: [],
      versionArgs: ["--version"],
      authArgs: ["login", "status"],
      authFormat: "codex-text",
      executableEnvVar: "CODEX_PATH",
    });
  });

  it("honors official executable environment overrides", () => {
    expect(
      resolveAcpServerMainCli(profile({ id: "claude-code", executable: "claude-agent-acp" }), {
        CLAUDE_CODE_EXECUTABLE: "/opt/claude-custom",
      })?.executable,
    ).toBe("/opt/claude-custom");
    expect(
      resolveAcpServerMainCli(profile({ id: "codex-acp", kind: "codex", executable: "codex-acp" }), {
        CODEX_PATH: "/opt/codex-custom",
      })?.executable,
    ).toBe("/opt/codex-custom");
  });

  it("does not resolve a main CLI for a custom bridge executable", () => {
    expect(
      resolveAcpServerMainCli(profile({ id: "claude-code", executable: "/opt/custom/claude-acp" }), {}),
    ).toBeUndefined();
  });
});
