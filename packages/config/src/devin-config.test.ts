import { describe, expect, it } from "vitest";
import {
  devinConfigFromEnvironment,
  resolveDevinConfig,
  toRedactedDevinConfigSnapshot,
  validateDevinConfig,
} from "./devin-config.js";

describe("Devin ACP configuration", () => {
  it("uses safe ACP defaults", () => {
    expect(resolveDevinConfig({})).toEqual({
      executable: "devin",
      transport: "acp",
      gracefulShutdownMs: 2000,
      terminateTimeoutMs: 3000,
      forceKillTimeoutMs: 1000,
      startupTimeoutMs: 10000,
      turnTimeoutMinutes: 45,
      inheritedMcpPolicy: "warn",
    });
  });

  it("applies user, repository, environment, and CLI sources in precedence order", () => {
    expect(
      resolveDevinConfig({
        user: { executable: "user-devin", turnTimeoutMinutes: 10 },
        repository: { turnTimeoutMinutes: 20 },
        environment: { turnTimeoutMinutes: 30 },
        cli: { turnTimeoutMinutes: 40 },
      }),
    ).toMatchObject({ executable: "user-devin", turnTimeoutMinutes: 40 });
  });

  it("parses supported environment overrides", () => {
    const environment = devinConfigFromEnvironment({
      MEGURIBI_DEVIN_TURN_TIMEOUT_MINUTES: "30",
      MEGURIBI_DEVIN_INHERITED_MCP_POLICY: "deny",
      MEGURIBI_DEVIN_TOKEN: "must-not-appear",
    });
    expect(environment).not.toHaveProperty("token");
    expect(
      resolveDevinConfig({
        repository: { turnTimeoutMinutes: 20 },
        environment,
      }),
    ).toMatchObject({ turnTimeoutMinutes: 30, inheritedMcpPolicy: "deny" });
  });

  it("rejects unsupported keys, transport, command templates, empty executable, and unsafe durations", () => {
    expect(() => validateDevinConfig({ transport: "stdio" })).toThrow(/transport/);
    expect(() => validateDevinConfig({ executable: "" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: "devin --token=SECRET" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: "devin acp" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ startupTimeoutMs: 0 })).toThrow(/startupTimeoutMs/);
    expect(() => validateDevinConfig({ startupTimeoutMs: 2_147_483_648 })).toThrow(/startupTimeoutMs/);
    expect(() => validateDevinConfig({ turnTimeoutMinutes: 35_792 })).toThrow(/turnTimeoutMinutes/);
    expect(() => validateDevinConfig({ unknown: true })).toThrow(/unknown/);
  });

  it("blocks non-interactive execution when inherited MCP policy is warn", () => {
    expect(() => resolveDevinConfig({ nonInteractive: true })).toThrow(/inheritedMcpPolicy/);
    expect(
      resolveDevinConfig({
        nonInteractive: true,
        cli: { inheritedMcpPolicy: "allow" },
      }),
    ).toMatchObject({ inheritedMcpPolicy: "allow" });
  });

  it("redacts secret-like values from the resolved snapshot", () => {
    expect(
      toRedactedDevinConfigSnapshot({
        executable: "devin",
        transport: "acp",
        inheritedMcpPolicy: "allow",
        extra: { token: "must-not-appear", safe: "kept" },
      }),
    ).toEqual({
      executable: "devin",
      transport: "acp",
      inheritedMcpPolicy: "allow",
      extra: { safe: "kept" },
    });
  });
});
