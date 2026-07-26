import { describe, expect, it } from "vitest";
import type { DevinDiagnosis } from "@meguribi/schemas";
import { runDoctor } from "./program.js";

const healthy: DevinDiagnosis = {
  executable: { status: "ok", path: "devin" },
  version: { status: "supported", raw: "3000.2.17" },
  authentication: { status: "authenticated" },
  acp: { status: "supported" },
  inheritedMcpPolicy: "allow",
  runnable: true,
  warnings: [],
  errors: [],
};

const configResult = {
  config: {
    executable: "devin",
    transport: "acp" as const,
    gracefulShutdownMs: 1,
    terminateTimeoutMs: 1,
    forceKillTimeoutMs: 1,
    startupTimeoutMs: 1000,
    turnTimeoutMinutes: 1,
    inheritedMcpPolicy: "allow" as const,
  },
  snapshot: { executable: "devin", inheritedMcpPolicy: "allow" },
};

describe("runDoctor", () => {
  it("prints human output and exits 0 when runnable", async () => {
    const chunks: string[] = [];
    const result = await runDoctor(
      {},
      {
        loadConfig: async () => configResult,
        diagnose: async () => healthy,
        stdout: (text) => {
          chunks.push(text);
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("✓ Devin CLI: 3000.2.17");
  });

  it("prints JSON only when --json is set", async () => {
    const chunks: string[] = [];
    const result = await runDoctor(
      { json: true },
      {
        loadConfig: async () => configResult,
        diagnose: async () => ({ ...healthy, runnable: false }),
        stdout: (text) => {
          chunks.push(text);
        },
      },
    );
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(chunks.join("")) as DevinDiagnosis;
    expect(parsed.runnable).toBe(false);
    expect(chunks.join("")).not.toContain("✓");
  });

  it("passes nonInteractive to diagnose and still emits structured JSON for warn policy", async () => {
    const chunks: string[] = [];
    let sawNonInteractive: boolean | undefined;
    let loadConfigNonInteractive: boolean | undefined;

    const blocked: DevinDiagnosis = {
      ...healthy,
      inheritedMcpPolicy: "warn",
      runnable: false,
      warnings: [
        {
          code: "inherited_mcp",
          message: "Saved Devin settings may include MCP servers",
        },
      ],
      errors: [
        {
          code: "policy_blocked",
          message: "inheritedMcpPolicy is warn, which is not allowed in non-interactive mode",
          nextAction: "Set inheritedMcpPolicy to allow or deny, or run interactively",
        },
      ],
    };

    const result = await runDoctor(
      { json: true, nonInteractive: true },
      {
        loadConfig: async (options) => {
          loadConfigNonInteractive = options?.nonInteractive;
          return {
            ...configResult,
            config: { ...configResult.config, inheritedMcpPolicy: "warn" as const },
          };
        },
        diagnose: async (options) => {
          sawNonInteractive = options.nonInteractive;
          return blocked;
        },
        stdout: (text) => {
          chunks.push(text);
        },
      },
    );

    expect(loadConfigNonInteractive).toBe(false);
    expect(sawNonInteractive).toBe(true);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(chunks.join("")) as DevinDiagnosis;
    expect(parsed.errors.some((error) => error.code === "policy_blocked")).toBe(true);
    expect(parsed.runnable).toBe(false);
  });
});
