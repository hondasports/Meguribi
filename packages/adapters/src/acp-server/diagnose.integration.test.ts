import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile } from "@meguribi/core";
import { diagnoseAcpServer } from "./diagnose.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function node(): string {
  return process.execPath;
}

function fakeAcpServer(): string {
  return fileURLToPath(new URL("../devin/fixtures/fake-acp-server.js", import.meta.url));
}

function claudeCodeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "claude-code",
    kind: "claude-code",
    transport: "acp",
    executable: "claude-agent-acp",
    startupTimeoutMs: 10_000,
    turnTimeoutMinutes: 45,
    inheritedMcpPolicy: "warn",
    ...overrides,
  };
}

async function tempCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-acp-server-diagnose-"));
  tempDirs.push(dir);
  return dir;
}

describe("diagnoseAcpServer integration", () => {
  it("reports runnable with unknown version/auth warnings for a working ACP server", async () => {
    const diagnosis = await diagnoseAcpServer({
      profile: claudeCodeProfile(),
      executable: node(),
      executableArgs: [fakeAcpServer()],
      cwd: await tempCwd(),
      nonInteractive: false,
      probeTimeoutMs: 5_000,
      env: { ...process.env, FAKE_ACP_MODE: "success" },
    });

    expect(diagnosis.runnable).toBe(true);
    expect(diagnosis.acp.status).toBe("supported");
    expect(diagnosis.executable.status).toBe("ok");
    expect(diagnosis.version.status).toBe("unknown");
    expect(diagnosis.authentication.status).toBe("unknown");
    const warningCodes = diagnosis.warnings.map((warning) => warning.code);
    expect(warningCodes).toContain("auth_unknown");
    expect(warningCodes).toContain("unknown_version");
    expect(diagnosis.errors).toEqual([]);
  });

  it("reports executable_not_found with the kind-specific install hint", async () => {
    const diagnosis = await diagnoseAcpServer({
      profile: claudeCodeProfile(),
      executable: "meguribi-no-such-acp",
      cwd: await tempCwd(),
      nonInteractive: false,
      probeTimeoutMs: 5_000,
      env: { ...process.env },
    });

    expect(diagnosis.runnable).toBe(false);
    expect(diagnosis.errors[0]?.code).toBe("executable_not_found");
    expect(diagnosis.errors[0]?.nextAction).toBe("npm i -g @agentclientprotocol/claude-agent-acp");
  });

  it("reports timeout when initialize never answers", async () => {
    const diagnosis = await diagnoseAcpServer({
      profile: claudeCodeProfile(),
      executable: node(),
      executableArgs: [fakeAcpServer()],
      cwd: await tempCwd(),
      nonInteractive: false,
      probeTimeoutMs: 300,
      env: { ...process.env, FAKE_ACP_MODE: "startup-hang" },
    });

    expect(diagnosis.runnable).toBe(false);
    expect(diagnosis.errors[0]?.code).toBe("timeout");
  });

  it("reports not runnable when the process crashes before initialize", async () => {
    const diagnosis = await diagnoseAcpServer({
      profile: claudeCodeProfile(),
      executable: node(),
      executableArgs: [fakeAcpServer()],
      cwd: await tempCwd(),
      nonInteractive: false,
      probeTimeoutMs: 5_000,
      env: { ...process.env, FAKE_ACP_MODE: "crash-before-init" },
    });

    expect(diagnosis.runnable).toBe(false);
    expect(diagnosis.errors.length).toBeGreaterThan(0);
  });

  it("blocks warn inherited MCP policy in non-interactive mode", async () => {
    const diagnosis = await diagnoseAcpServer({
      profile: claudeCodeProfile({ inheritedMcpPolicy: "warn" }),
      executable: node(),
      executableArgs: [fakeAcpServer()],
      cwd: await tempCwd(),
      nonInteractive: true,
      probeTimeoutMs: 5_000,
      env: { ...process.env, FAKE_ACP_MODE: "success" },
    });

    expect(diagnosis.runnable).toBe(false);
    expect(diagnosis.errors.some((error) => error.code === "policy_blocked")).toBe(true);
  });
});
