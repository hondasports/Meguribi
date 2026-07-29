import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createCommandVerifier,
  parseVerifyCommand,
  resolvePlatformExecutable,
  resolveVerifierInvocation,
} from "./command-verifier.js";

describe("parseVerifyCommand", () => {
  it("splits simple pnpm commands", () => {
    expect(parseVerifyCommand("pnpm test")).toEqual({
      executable: "pnpm",
      args: ["test"],
    });
  });

  it("rejects shell metacharacters", () => {
    expect(() => parseVerifyCommand("pnpm test & calc.exe")).toThrow(/metacharacters/i);
    expect(() => parseVerifyCommand("pnpm test | cat")).toThrow(/metacharacters/i);
    expect(() => parseVerifyCommand("pnpm test > out.txt")).toThrow(/metacharacters/i);
  });

  it("rejects quoting that could change a Windows command line", () => {
    expect(() => parseVerifyCommand('pnpm test "unsafe"')).toThrow(/metacharacters/i);
  });
});

describe("resolveVerifierInvocation", () => {
  it("wraps Windows command shims with ComSpec", () => {
    expect(
      resolveVerifierInvocation("C:\\Program Files\\pnpm.CMD", ["lint"], {
        platform: "win32",
        comSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\Program Files\\pnpm.CMD" lint'],
    });
  });

  it("leaves normal executables unchanged", () => {
    expect(resolveVerifierInvocation("node.exe", ["test.mjs"], { platform: "win32" })).toEqual({
      executable: "node.exe",
      args: ["test.mjs"],
    });
  });
});

describe("resolvePlatformExecutable", () => {
  it("leaves non-Windows platforms unchanged", () => {
    expect(
      resolvePlatformExecutable("node", {
        platform: "linux",
        env: { PATH: "/usr/bin", PATHEXT: ".EXE;.CMD" },
      }),
    ).toBe("node");
  });

  it("leaves paths and extensioned names unchanged on Windows", () => {
    expect(
      resolvePlatformExecutable("C:\\tools\\node.exe", {
        platform: "win32",
        env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
        pathExists: () => true,
      }),
    ).toBe("C:\\tools\\node.exe");
    expect(
      resolvePlatformExecutable("tool.cmd", {
        platform: "win32",
        env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
        pathExists: () => true,
      }),
    ).toBe("tool.cmd");
  });

  it("prefers PATHEXT order (.EXE before .CMD) instead of blind .cmd rewrite", () => {
    const seen: string[] = [];
    const resolved = resolvePlatformExecutable("node", {
      platform: "win32",
      env: {
        PATH: "C:\\fake-bin",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
      pathExists: (candidate) => {
        seen.push(candidate);
        return candidate === path.join("C:\\fake-bin", "node.EXE");
      },
    });
    expect(resolved).toBe(path.join("C:\\fake-bin", "node.EXE"));
    expect(seen).toEqual([
      path.join("C:\\fake-bin", "node.COM"),
      path.join("C:\\fake-bin", "node.EXE"),
    ]);
  });

  it("falls back to the original name when nothing matches", () => {
    expect(
      resolvePlatformExecutable("missing-tool", {
        platform: "win32",
        env: { PATH: "C:\\empty", PATHEXT: ".EXE;.CMD" },
        pathExists: () => false,
      }),
    ).toBe("missing-tool");
  });
});

describe("createCommandVerifier", () => {
  const fixtureDir = fileURLToPath(new URL("./fixtures", import.meta.url));
  const resolveNode = (executable: string): string =>
    executable === "node" ? process.execPath : executable;

  it("writes redacted and truncated output through the log writer", async () => {
    let written:
      | {
          stdout: string;
          stderr: string;
          truncated: boolean;
        }
      | undefined;
    const verifier = createCommandVerifier({
      maxLogBytes: 64,
      resolveExecutable: resolveNode,
    });
    const result = await verifier.verify({
      worktreePath: fixtureDir,
      commands: [{ name: "emit output", run: "node emit-output.js" }],
      logWriter: {
        async write(input) {
          written = input;
          return "logs/verify-01-emit-output.log";
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.commands[0]?.logPath).toBe("logs/verify-01-emit-output.log");
    expect(written?.stdout).toContain("visible output");
    expect(written?.stdout).not.toContain("fixture-token-value");
    expect(written?.stderr).toContain("visible stderr");
    expect(written?.truncated).toBe(true);
  });

  it("writes a log when a command exits non-zero", async () => {
    let written: { stderr: string } | undefined;
    const verifier = createCommandVerifier({ resolveExecutable: resolveNode });
    const result = await verifier.verify({
      worktreePath: fixtureDir,
      commands: [{ name: "failing command", run: "node emit-output.js fail" }],
      logWriter: {
        async write(input) {
          written = input;
          return "logs/verify-01-failing-command.log";
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.commands[0]?.exitCode).not.toBe(0);
    expect(result.commands[0]?.logPath).toBe("logs/verify-01-failing-command.log");
    expect(written?.stderr).toContain("visible stderr");
  });

  it("records timedOut when a hung command exceeds timeoutMs", async () => {
    const verifier = createCommandVerifier({
      timeoutMs: 200,
      resolveExecutable: resolveNode,
    });
    const result = await verifier.verify({
      worktreePath: fixtureDir,
      timeoutMs: 200,
      commands: [{ name: "hang", run: "node hang.js" }],
    });
    expect(result.success).toBe(false);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({
      name: "hang",
      exitCode: null,
      timedOut: true,
    });
  }, 15_000);

  it("propagates AbortSignal cancellation without marking success", async () => {
    const controller = new AbortController();
    const verifier = createCommandVerifier({
      timeoutMs: 30_000,
      resolveExecutable: resolveNode,
    });
    const pending = verifier.verify({
      worktreePath: fixtureDir,
      abortSignal: controller.signal,
      commands: [{ name: "hang", run: "node hang.js" }],
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  }, 15_000);
});
