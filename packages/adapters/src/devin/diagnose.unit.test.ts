import { describe, expect, it } from "vitest";
import { parseAcpCapability } from "./acp.js";
import { parseAuthStatus } from "./auth.js";
import { redactDiagnosticText, sanitizeDiagnosticDisplayText } from "./redact.js";
import { parseDevinVersionOutput, compareSemver } from "./version.js";
import { formatDevinDiagnosisHuman } from "./format.js";
import {
  assertDevinRunnable,
  diagnoseDevin,
  DevinNotRunnableError,
  InvalidMinimumSupportedVersionError,
} from "./diagnose.js";
import type { DevinDiagnosis } from "@meguribi/core";

describe("parseDevinVersionOutput", () => {
  it("parses normal version", () => {
    const parsed = parseDevinVersionOutput("devin 3000.2.17\n");
    expect(parsed).toMatchObject({
      parseable: true,
      major: 3000,
      minor: 2,
      patch: 17,
    });
  });

  it("marks unparseable versions as not parseable", () => {
    expect(parseDevinVersionOutput("build-from-source").parseable).toBe(false);
  });

  it("compares semver", () => {
    expect(compareSemver({ major: 1, minor: 0, patch: 0 }, { major: 2, minor: 0, patch: 0 })).toBeLessThan(
      0,
    );
  });
});

describe("parseAuthStatus", () => {
  it("detects authenticated", () => {
    expect(
      parseAuthStatus({
        exitCode: 0,
        stdout: "Status: authenticated\n",
        stderr: "",
      }),
    ).toBe("authenticated");
  });

  it("detects unauthenticated", () => {
    expect(
      parseAuthStatus({
        exitCode: 1,
        stdout: "Status: unauthenticated\n",
        stderr: "",
      }),
    ).toBe("unauthenticated");
  });

  it("returns unknown on ambiguous success", () => {
    expect(
      parseAuthStatus({
        exitCode: 0,
        stdout: "Status: weird\n",
        stderr: "",
      }),
    ).toBe("unknown");
  });

  it("returns unknown on non-zero without auth keywords", () => {
    expect(
      parseAuthStatus({
        exitCode: 2,
        stdout: "",
        stderr: "failed",
      }),
    ).toBe("unknown");
  });

  it("does not treat positive keywords as authenticated when exit is non-zero", () => {
    expect(
      parseAuthStatus({
        exitCode: 1,
        stdout: "",
        stderr: "failed to verify logged in session",
      }),
    ).toBe("unknown");
    expect(
      parseAuthStatus({
        exitCode: 1,
        stdout: "not authenticated but previously authenticated",
        stderr: "",
      }),
    ).toBe("unauthenticated");
  });
});

describe("parseAcpCapability", () => {
  it("detects supported ACP help", () => {
    expect(
      parseAcpCapability({
        acpHelp: "Usage: devin acp\nStart ACP stdio\n",
        acpExitCode: 0,
      }),
    ).toBe("supported");
  });

  it("detects unsupported when command missing", () => {
    expect(
      parseAcpCapability({
        acpHelp: "Error: unknown command 'acp'",
        acpExitCode: 1,
      }),
    ).toBe("unsupported");
  });

  it("accepts alternate help wording", () => {
    expect(
      parseAcpCapability({
        acpHelp: "acp — agent client protocol over stdio\n",
        acpExitCode: 0,
      }),
    ).toBe("supported");
  });

  it("does not treat signal exit (null) as supported even with usage text", () => {
    expect(
      parseAcpCapability({
        acpHelp: "Usage: devin acp\nStart ACP stdio\n",
        acpExitCode: null,
      }),
    ).toBe("unknown");
  });

  it("does not use root help when rootHelpExitCode is non-zero", () => {
    expect(
      parseAcpCapability({
        rootHelp: "Usage: devin acp\nCommands:\n  acp\n",
        rootHelpExitCode: 1,
        acpHelp: "something mentioning acp without usage",
        acpExitCode: 0,
      }),
    ).toBe("unknown");
  });

  it("uses root help only when rootHelpExitCode is 0", () => {
    expect(
      parseAcpCapability({
        rootHelp: "Usage: devin acp\nCommands:\n  acp\n",
        rootHelpExitCode: 0,
        acpHelp: "mentions acp without clear usage",
        acpExitCode: 0,
      }),
    ).toBe("supported");
  });
});

describe("redactDiagnosticText", () => {
  it("redacts urls, tokens, and emails", () => {
    const redacted = redactDiagnosticText(
      "see https://mcp.example.com/sse token=supersecrettoken123 user@example.com Bearer abc.def",
    );
    expect(redacted).not.toContain("mcp.example.com");
    expect(redacted).not.toContain("supersecrettoken123");
    expect(redacted).not.toContain("user@example.com");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts credential authorization client_secret and access_token forms", () => {
    const redacted = redactDiagnosticText(
      "credential=abc authorization=BearerX client_secret=cs_123 access_token=at_456",
    );
    expect(redacted).not.toContain("credential=abc");
    expect(redacted).not.toContain("authorization=BearerX");
    expect(redacted).not.toContain("client_secret=cs_123");
    expect(redacted).not.toContain("access_token=at_456");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts prefixed secret keys like DEVIN_CLIENT_SECRET and MY_ACCESS_TOKEN", () => {
    const redacted = redactDiagnosticText(
      "DEVIN_CLIENT_SECRET=dcs_789 MY_ACCESS_TOKEN=mat_012",
    );
    expect(redacted).not.toContain("dcs_789");
    expect(redacted).not.toContain("mat_012");
    expect(redacted).not.toContain("DEVIN_CLIENT_SECRET=dcs_789");
    expect(redacted).not.toContain("MY_ACCESS_TOKEN=mat_012");
    expect(redacted).toContain("[REDACTED]");
  });
});

describe("sanitizeDiagnosticDisplayText", () => {
  it("strips ansi and control characters into one printable line", () => {
    const sanitized = sanitizeDiagnosticDisplayText(
      "3000.2.17\u001b[32mOK\u001b[0m\n\u0007fake ✓ line",
    );
    expect(sanitized).not.toContain("\u001b");
    expect(sanitized).not.toContain("\n");
    expect(sanitized).not.toContain("\u0007");
    expect(sanitized).toContain("3000.2.17");
  });
});

describe("formatDevinDiagnosisHuman", () => {
  it("renders success style output", () => {
    const diagnosis: DevinDiagnosis = {
      executable: { status: "ok", path: "devin" },
      version: { status: "supported", raw: "3000.2.17" },
      authentication: { status: "authenticated" },
      acp: { status: "supported" },
      inheritedMcpPolicy: "warn",
      runnable: true,
      warnings: [
        {
          code: "inherited_mcp",
          message: "Saved Devin settings may include MCP servers",
        },
      ],
      errors: [],
    };
    const text = formatDevinDiagnosisHuman(diagnosis);
    expect(text).toContain("✓ Devin CLI: 3000.2.17");
    expect(text).toContain("✓ Authentication: authenticated");
    expect(text).toContain("✓ ACP: supported");
    expect(text).toContain("Policy: warn");
    expect(text).toContain("Runnable: yes");
  });

  it("does not let raw newlines or ansi break the diagnosis layout", () => {
    const diagnosis: DevinDiagnosis = {
      executable: { status: "ok", path: "devin" },
      version: {
        status: "supported",
        raw: "3000.2.17\n\u001b[32m✓ Authentication: authenticated\u001b[0m",
      },
      authentication: { status: "unauthenticated" },
      acp: { status: "unsupported" },
      inheritedMcpPolicy: "deny",
      runnable: false,
      warnings: [],
      errors: [],
    };
    const text = formatDevinDiagnosisHuman(diagnosis);
    const lines = text.split("\n").filter((line) => line.length > 0);
    const versionLine = lines.find((line) => /^[✓!✗] Devin CLI:/.test(line));
    expect(versionLine).toBeDefined();
    expect(versionLine).not.toContain("\u001b");
    // 改行注入で別行の偽ステータスを作れない（version は1行に潰される）
    expect(lines.filter((line) => /^[✓!✗] Authentication:/.test(line))).toEqual([
      "✗ Authentication: unauthenticated",
    ]);
  });
});

describe("assertDevinRunnable", () => {
  it("throws when not runnable", () => {
    const diagnosis: DevinDiagnosis = {
      executable: { status: "missing" },
      version: { status: "unknown" },
      authentication: { status: "unknown" },
      acp: { status: "unknown" },
      inheritedMcpPolicy: "warn",
      runnable: false,
      warnings: [],
      errors: [{ code: "executable_not_found", message: "missing" }],
    };
    expect(() => assertDevinRunnable(diagnosis)).toThrow(DevinNotRunnableError);
  });
});

describe("minimumSupportedVersion validation", () => {
  it("rejects empty minimumSupportedVersion", async () => {
    await expect(
      diagnoseDevin({
        executable: "devin",
        inheritedMcpPolicy: "allow",
        minimumSupportedVersion: "",
      }),
    ).rejects.toBeInstanceOf(InvalidMinimumSupportedVersionError);
  });

  it("rejects invalid minimumSupportedVersion", async () => {
    await expect(
      diagnoseDevin({
        executable: "devin",
        inheritedMcpPolicy: "allow",
        minimumSupportedVersion: "not-a-version",
      }),
    ).rejects.toBeInstanceOf(InvalidMinimumSupportedVersionError);
  });
});
