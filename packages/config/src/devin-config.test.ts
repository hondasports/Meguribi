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

  it("accepts MEGURIBI_DEVIN_EXECUTABLE as a plain string without spaces", () => {
    const environment = devinConfigFromEnvironment({
      MEGURIBI_DEVIN_EXECUTABLE: "devin",
    });
    expect(environment).toMatchObject({ executable: "devin" });
  });

  it("accepts a JSON one-element tuple in MEGURIBI_DEVIN_EXECUTABLE for spaced paths", () => {
    const environment = devinConfigFromEnvironment({
      MEGURIBI_DEVIN_EXECUTABLE: '["C:\\\\Program Files\\\\Devin\\\\devin.exe"]',
    });
    expect(environment).toMatchObject({ executable: ["C:\\Program Files\\Devin\\devin.exe"] });
    expect(
      resolveDevinConfig({ environment }),
    ).toMatchObject({ executable: "C:\\Program Files\\Devin\\devin.exe" });

    const unixEnv = devinConfigFromEnvironment({
      MEGURIBI_DEVIN_EXECUTABLE: '["/my dir/bin/devin"]',
    });
    expect(resolveDevinConfig({ environment: unixEnv })).toMatchObject({
      executable: "/my dir/bin/devin",
    });
  });

  it("rejects plain spaced and command-template values in MEGURIBI_DEVIN_EXECUTABLE", () => {
    // Plain strings with spaces are not auto-converted to a tuple.
    expect(() =>
      resolveDevinConfig({
        environment: devinConfigFromEnvironment({
          MEGURIBI_DEVIN_EXECUTABLE: "C:\\Program Files\\Devin\\devin.exe",
        }),
      }),
    ).toThrow(/executable/);
    expect(() =>
      resolveDevinConfig({
        environment: devinConfigFromEnvironment({
          MEGURIBI_DEVIN_EXECUTABLE: "devin acp",
        }),
      }),
    ).toThrow(/executable/);
    expect(() =>
      resolveDevinConfig({
        environment: devinConfigFromEnvironment({
          MEGURIBI_DEVIN_EXECUTABLE: "/usr/local/bin/devin acp",
        }),
      }),
    ).toThrow(/executable/);
    expect(() =>
      resolveDevinConfig({
        environment: devinConfigFromEnvironment({
          MEGURIBI_DEVIN_EXECUTABLE: "C:\\Program Files\\Devin\\devin acp",
        }),
      }),
    ).toThrow(/executable/);
    expect(() =>
      resolveDevinConfig({
        environment: devinConfigFromEnvironment({
          MEGURIBI_DEVIN_EXECUTABLE: "/usr/local/bin/devin ./acp",
        }),
      }),
    ).toThrow(/executable/);
    expect(() =>
      resolveDevinConfig({
        environment: devinConfigFromEnvironment({
          MEGURIBI_DEVIN_EXECUTABLE: "devin --token=SECRET",
        }),
      }),
    ).toThrow(/executable/);
  });

  it("rejects unsupported keys, transport, command templates, secret flags, empty executable, and unsafe durations", () => {
    expect(() => validateDevinConfig({ transport: "stdio" })).toThrow(/transport/);
    expect(() => validateDevinConfig({ executable: "" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: "devin --token=SECRET" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: "devin acp" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: "FOO=bar devin" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: "http://example.com/devin" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: [""] })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: ["devin", "acp"] })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: ["/usr/local/bin/devin", "./acp"] })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: ["/usr/local/bin/devin acp"] })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: ["C:\\Program Files\\Devin\\devin acp"] })).toThrow(/executable/);
    expect(() => validateDevinConfig({ startupTimeoutMs: 0 })).toThrow(/startupTimeoutMs/);
    expect(() => validateDevinConfig({ startupTimeoutMs: 2_147_483_648 })).toThrow(/startupTimeoutMs/);
    expect(() => validateDevinConfig({ turnTimeoutMinutes: 35_792 })).toThrow(/turnTimeoutMinutes/);
    expect(() => validateDevinConfig({ unknown: true })).toThrow(/unknown/);
  });

  it("allows legitimate executable paths without spaces", () => {
    expect(() => validateDevinConfig({ executable: "devin" })).not.toThrow();
    expect(() => validateDevinConfig({ executable: "./devin" })).not.toThrow();
    expect(() => validateDevinConfig({ executable: "~/bin/devin" })).not.toThrow();
    expect(() => validateDevinConfig({ executable: "C:/tools/devin.exe" })).not.toThrow();
  });

  it("allows spaces in executable paths only as a one-element tuple", () => {
    expect(() => validateDevinConfig({ executable: ["C:/Program Files/Devin/devin.exe"] })).not.toThrow();
    expect(() => validateDevinConfig({ executable: ["C:\\Program Files\\Devin\\devin.exe"] })).not.toThrow();
    expect(() => validateDevinConfig({ executable: ["C:\\Program Files (x86)\\Devin\\devin.exe"] })).not.toThrow();
    expect(
      resolveDevinConfig({
        cli: { executable: ["C:\\Program Files\\Devin\\devin.exe"] },
      }),
    ).toMatchObject({ executable: "C:\\Program Files\\Devin\\devin.exe" });
  });

  it("rejects paths with spaces when given as a plain string", () => {
    expect(() => validateDevinConfig({ executable: "C:\\Program Files\\Devin\\devin.exe" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: "/usr/local/bin/devin acp" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: "C:\\Program Files\\Devin\\devin acp" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: "C:\\Program Files\\Devin\\devin.exe -t" })).toThrow(/executable/);
    expect(() => validateDevinConfig({ executable: "/usr/local/bin/devin --token=SECRET" })).toThrow(/executable/);
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
