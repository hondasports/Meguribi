import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { ProcessRunner } from "@meguribi/process";
import { DevinDiagnosisSchema } from "@meguribi/schemas";
import * as v from "valibot";
import { diagnoseDevin, type DiagnoseDevinOptions } from "./diagnose.js";
import { redactDiagnosticText } from "./redact.js";

function node(): string {
  return process.execPath;
}

function fakeScript(): string {
  return fileURLToPath(new URL("./fixtures/fake-devin.js", import.meta.url));
}

function env(mode: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FAKE_DEVIN_MODE: mode,
  };
}

async function diagnose(
  mode: string,
  overrides: Partial<DiagnoseDevinOptions> = {},
) {
  return diagnoseDevin({
    executable: node(),
    executableArgs: [fakeScript()],
    inheritedMcpPolicy: "allow",
    cwd: process.cwd(),
    env: env(mode),
    runner: new ProcessRunner(),
    probeTimeoutMs: 3000,
    ...overrides,
  });
}

describe("diagnoseDevin integration with fake executable", () => {
  it("reports healthy runnable diagnosis", async () => {
    const result = await diagnose("ok");
    expect(v.parse(DevinDiagnosisSchema, result)).toMatchObject({
      executable: { status: "ok" },
      version: { status: "supported", raw: expect.stringContaining("3000.2.17") },
      authentication: { status: "authenticated" },
      acp: { status: "supported" },
      runnable: true,
    });
  });

  it("supports the public scenario environment variable for preflight", async () => {
    const result = await diagnoseDevin({
      executable: node(),
      executableArgs: [fakeScript()],
      inheritedMcpPolicy: "allow",
      cwd: process.cwd(),
      env: { ...process.env, MEGURIBI_FAKE_DEVIN_SCENARIO: "unsupported-version" },
      runner: new ProcessRunner(),
      probeTimeoutMs: 3000,
      minimumSupportedVersion: "3000.0.0",
    });

    expect(result.version.status).toBe("unsupported");
    expect(result.runnable).toBe(false);
  });

  it("reports missing executable", async () => {
    const result = await diagnoseDevin({
      executable: "this-devin-binary-does-not-exist-anywhere",
      inheritedMcpPolicy: "allow",
      cwd: process.cwd(),
      env: { ...process.env },
      runner: new ProcessRunner(),
    });
    expect(result.executable.status).toBe("missing");
    expect(result.runnable).toBe(false);
    expect(result.errors.some((error) => error.code === "executable_not_found")).toBe(true);
  });

  it("marks unparseable version as unknown but can still run with ACP", async () => {
    const result = await diagnose("version-unknown");
    expect(result.version.status).toBe("unknown");
    expect(result.warnings.some((warning) => warning.code === "unknown_version")).toBe(true);
    expect(result.acp.status).toBe("supported");
    expect(result.runnable).toBe(true);
  });

  it("marks unsupported version when below minimum", async () => {
    const result = await diagnose("version-unsupported", {
      minimumSupportedVersion: "3000.0.0",
    });
    expect(result.version.status).toBe("unsupported");
    expect(result.runnable).toBe(false);
    expect(result.errors.some((error) => error.code === "unsupported_version")).toBe(true);
  });

  it("applies default minimum supported version without explicit override", async () => {
    const result = await diagnose("version-unsupported");
    expect(result.version.status).toBe("unsupported");
    expect(result.runnable).toBe(false);
    expect(result.errors.some((error) => error.code === "unsupported_version")).toBe(true);
  });

  it("fails closed when version probe exits non-zero", async () => {
    const result = await diagnose("version-exit-error");
    expect(result.runnable).toBe(false);
    expect(result.errors.some((error) => error.code === "process_crashed")).toBe(true);
    expect(result.authentication.status).toBe("unknown");
    expect(result.acp.status).toBe("unknown");
  });

  it("detects unauthenticated status", async () => {
    const result = await diagnose("auth-unauthenticated");
    expect(result.authentication.status).toBe("unauthenticated");
    expect(result.runnable).toBe(false);
    expect(result.errors.some((error) => error.code === "unauthenticated")).toBe(true);
    expect(result.errors.find((error) => error.code === "unauthenticated")?.nextAction).toContain(
      "devin auth login",
    );
  });

  it("treats auth command failure without keywords as unknown", async () => {
    const result = await diagnose("auth-error");
    expect(result.authentication.status).toBe("unknown");
    expect(result.runnable).toBe(false);
    expect(result.warnings.some((warning) => warning.code === "auth_unknown")).toBe(true);
    expect(result.errors.some((error) => error.code === "unauthenticated")).toBe(false);
  });

  it("treats ambiguous auth success as unknown", async () => {
    const result = await diagnose("auth-unknown");
    expect(result.authentication.status).toBe("unknown");
    expect(result.runnable).toBe(false);
    expect(result.warnings.some((warning) => warning.code === "auth_unknown")).toBe(true);
  });

  it("detects missing ACP capability", async () => {
    const result = await diagnose("no-acp");
    expect(result.acp.status).toBe("unsupported");
    expect(result.runnable).toBe(false);
    expect(result.errors.some((error) => error.code === "capability_missing")).toBe(true);
    expect(result.errors.some((error) => error.code === "unsupported_version")).toBe(false);
  });

  it("accepts alternate ACP help output", async () => {
    const result = await diagnose("acp-help-changed");
    expect(result.acp.status).toBe("supported");
    expect(result.runnable).toBe(true);
  });

  it("does not treat ACP probe signal exit as supported", async () => {
    const result = await diagnose("acp-signal");
    expect(result.acp.status).not.toBe("supported");
    expect(result.runnable).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          error.code === "process_crashed" || error.code === "capability_missing",
      ) || result.warnings.some((warning) => warning.code === "acp_unknown"),
    ).toBe(true);
  });

  it("fails closed when version probe floods stdout", async () => {
    const result = await diagnose("version-flood", { probeTimeoutMs: 5_000 });
    expect(result.runnable).toBe(false);
    expect(result.version.status).toBe("unknown");
    expect(result.errors.some((error) => error.code === "process_crashed")).toBe(true);
    expect(result.authentication.status).toBe("unknown");
    expect(result.acp.status).toBe("unknown");
  }, 15_000);

  it("fails closed when ACP probe floods stdout", async () => {
    const result = await diagnose("flood-output", { probeTimeoutMs: 5_000 });
    expect(result.runnable).toBe(false);
    expect(result.acp.status).not.toBe("supported");
    expect(result.errors.some((error) => error.code === "process_crashed")).toBe(true);
  }, 15_000);

  it("rejects empty minimumSupportedVersion before probing", async () => {
    await expect(diagnose("ok", { minimumSupportedVersion: "" })).rejects.toThrow(
      /Invalid minimumSupportedVersion/,
    );
  });

  it("times out probes safely", async () => {
    const result = await diagnose("timeout", { probeTimeoutMs: 200 });
    expect(result.runnable).toBe(false);
    expect(result.errors.some((error) => error.code === "timeout")).toBe(true);
    expect(result.version.status).toBe("unknown");
  }, 15_000);

  it("warns for MCP warn policy", async () => {
    const result = await diagnose("ok", { inheritedMcpPolicy: "warn", nonInteractive: false });
    expect(result.warnings.some((warning) => warning.code === "inherited_mcp")).toBe(true);
    expect(result.runnable).toBe(true);
  });

  it("blocks non-interactive warn MCP policy", async () => {
    const result = await diagnose("ok", { inheritedMcpPolicy: "warn", nonInteractive: true });
    expect(result.runnable).toBe(false);
    expect(result.errors.some((error) => error.code === "policy_blocked")).toBe(true);
  });

  it("does not leak secret-like strings into diagnosis messages", async () => {
    const result = await diagnose("version-secret");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("supersecrettoken123");
    expect(serialized).not.toContain("mcp.example.com");
    expect(serialized).not.toContain("credential=abc");
    expect(serialized).not.toContain("client_secret=cs_123");
    expect(serialized).not.toContain("access_token=at_456");
    expect(serialized).not.toContain("dcs_789");
    expect(serialized).not.toContain("mat_012");
    expect(serialized).not.toContain("DEVIN_CLIENT_SECRET=");
    expect(serialized).not.toContain("MY_ACCESS_TOKEN=");
    expect(redactDiagnosticText(serialized)).toBe(serialized);
  });
});
