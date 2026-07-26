import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentErrorCode } from "@meguribi/core";
import {
  ProcessError,
  ProcessRunner,
  filterEnvironment,
  toAgentError,
  toProcessError,
  type ManagedProcess,
  type ProcessErrorCode,
} from "./index.js";

const runner = new ProcessRunner();

function node(): string {
  return process.execPath;
}

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function waitForFile(path: string, timeoutMs = 15000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      readFileSync(path);
      return;
    } catch {
      await delay(intervalMs);
    }
  }
  throw new Error(`Timeout waiting for file: ${path}`);
}

let current: ManagedProcess | undefined;

afterEach(async () => {
  if (current) {
    try {
      await current.terminateTree({ graceMs: 100 });
    } catch {
      // ignore cleanup failures
    }
    current = undefined;
  }
});

describe("ProcessRunner", () => {
  it("exits successfully and captures stdout/stderr with timestamps", async () => {
    const before = Date.now();
    current = runner.run(node(), [fixture("success.js")], {
      cwd: process.cwd(),
    });
    expect(current.startedAt).toBeDefined();
    const started = new Date(current.startedAt).getTime();
    expect(started).toBeGreaterThanOrEqual(before);

    const [out, err, result] = await Promise.all([
      collect(current.stdout),
      collect(current.stderr),
      current.waitForExit(),
    ]);

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.startedAt).toBe(current.startedAt);
    expect(new Date(result.finishedAt).getTime()).toBeGreaterThanOrEqual(started);
    expect(out).toContain("stdout-line");
    expect(err).toContain("stderr-line");
  });

  it("exits with a non-zero code", async () => {
    current = runner.run(node(), [fixture("exit-code.js"), "42"], {
      cwd: process.cwd(),
    });
    const result = await current.waitForExit();
    expect(result.code).toBe(42);
  });

  it("echoes stdin to stdout", async () => {
    current = runner.run(node(), [fixture("echo.js")], { cwd: process.cwd() });
    await current.writeStdin("hello\n");
    await current.closeStdin();
    const out = await collect(current.stdout);
    const result = await current.waitForExit();
    expect(out).toBe("hello\n");
    expect(result.code).toBe(0);
  });

  it("writes large stdin without losing data", async () => {
    current = runner.run(node(), [fixture("echo.js")], { cwd: process.cwd() });
    const size = 64 * 1024;
    const payload = "x".repeat(size);
    await current.writeStdin(payload);
    await current.closeStdin();
    const [out, result] = await Promise.all([collect(current.stdout), current.waitForExit()]);
    expect(out.length).toBe(size);
    expect(out).toBe(payload);
    expect(result.code).toBe(0);
  });

  it("times out and terminates the process", async () => {
    current = runner.run(node(), [fixture("ignore-sigterm.js")], {
      cwd: process.cwd(),
      timeoutMs: 100,
      terminationGraceMs: 100,
    });
    await expect(current.waitForExit()).rejects.toThrow(ProcessError);
    await expect(current.waitForExit()).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("cancels via AbortSignal and terminates the process", async () => {
    const controller = new AbortController();
    current = runner.run(node(), [fixture("ignore-sigterm.js")], {
      cwd: process.cwd(),
      abortSignal: controller.signal,
      terminationGraceMs: 100,
    });
    controller.abort();
    await expect(current.waitForExit()).rejects.toThrow(ProcessError);
    await expect(current.waitForExit()).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("terminates on SIGTERM", async () => {
    current = runner.run(node(), [fixture("cancel-listener.js")], {
      cwd: process.cwd(),
    });
    await current.signal("SIGTERM");
    const result = await current.waitForExit();
    expect(result.code === 0 || result.signal === "SIGTERM").toBe(true);
  });

  it("force terminates after SIGTERM is ignored", async () => {
    current = runner.run(node(), [fixture("ignore-sigterm.js")], {
      cwd: process.cwd(),
    });
    const pid = current.pid;
    await current.signal("SIGTERM");
    const result = await current.terminateTree({ graceMs: 100 });
    expect(result.signal ?? result.code).toBeTruthy();
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("recovers process tree", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "meguribi-process-"));
    const pidFile = join(tmpDir, "child.pid");
    current = runner.run(node(), [fixture("spawn-child.js")], {
      cwd: process.cwd(),
      env: { MEGURIBI_TEST_PID_FILE: pidFile },
    });
    await waitForFile(pidFile);
    const childPid = Number(readFileSync(pidFile, "utf-8"));
    await current.terminateTree({ graceMs: 100 });
    expect(() => process.kill(childPid, 0)).toThrow();
    unlinkSync(pidFile);
    rmdirSync(tmpDir);
  });

  it("is idempotent for closeStdin and terminateTree", async () => {
    current = runner.run(node(), [fixture("ignore-sigterm.js")], {
      cwd: process.cwd(),
    });
    await current.closeStdin();
    await current.closeStdin();
    await current.terminateTree({ graceMs: 100 });
    await expect(current.terminateTree({ graceMs: 100 })).resolves.toBeDefined();
  });

  it("returns the same spawn error from every operation when executable is not found", async () => {
    current = runner.run("this-does-not-exist-executable", [], { cwd: process.cwd() });
    expect(current.pid).toBeUndefined();
    const results = await Promise.allSettled([
      current.waitForExit(),
      current.terminateTree(),
      current.signal("SIGTERM"),
      current.writeStdin("input"),
      current.closeStdin(),
    ]);
    const errors = results.map((result) => {
      expect(result.status).toBe("rejected");
      return (result as PromiseRejectedResult).reason;
    });
    expect(errors[0]).toBeInstanceOf(ProcessError);
    expect(errors[0]).toMatchObject({ code: "executable_not_found" });
    for (const error of errors.slice(1)) {
      expect(error).toBe(errors[0]);
    }
  });

  it("requires cwd", () => {
    expect(() => runner.run(node(), [], { cwd: "" })).toThrow(ProcessError);
  });

  it("filters environment variables", async () => {
    current = runner.run(node(), [fixture("env-echo.js")], {
      cwd: process.cwd(),
      env: { FOO: "bar", SECRET: "x" },
      envAllow: ["FOO"],
    });
    const out = await collect(current.stdout);
    await current.waitForExit();
    expect(out).toContain("FOO");
    expect(out).not.toContain("SECRET");
  });

  it("does not lose output after exit", async () => {
    current = runner.run(node(), [fixture("late-output.js")], {
      cwd: process.cwd(),
    });
    const [out, result] = await Promise.all([collect(current.stdout), current.waitForExit()]);
    expect(out).toContain("late");
    expect(result.code).toBe(0);
  });

  it("maps errors to AgentError", () => {
    const cases: Array<[ProcessErrorCode, AgentErrorCode]> = [
      ["executable_not_found", "executable_not_found"],
      ["timeout", "timeout"],
      ["cancelled", "cancelled"],
      ["permission_denied", "permission_denied"],
      ["process_crashed", "process_crashed"],
      ["force_failed", "cleanup_failed"],
      ["unsupported_signal", "unsupported_signal"],
      ["unknown", "unknown"],
    ];
    for (const [processCode, agentCode] of cases) {
      const err = new ProcessError(processCode, "test", false);
      expect(toAgentError(err).code).toBe(agentCode);
    }
  });

  it("classifies toProcessError codes", () => {
    const make = (code: string, message: string): Error => {
      return Object.assign(new Error(message), { code });
    };
    expect(toProcessError(make("ENOENT", "not found")).code).toBe("executable_not_found");
    expect(toProcessError(make("EACCES", "access denied")).code).toBe("permission_denied");
    expect(toProcessError(make("EPERM", "not permitted")).code).toBe("permission_denied");
    expect(toProcessError(make("ETIMEDOUT", "timed out")).code).toBe("timeout");
    expect(toProcessError(make("UNKNOWN", "oops")).code).toBe("process_crashed");
  });

  it("throws unsupported_signal for invalid signal", async () => {
    current = runner.run(node(), [fixture("ignore-sigterm.js")], {
      cwd: process.cwd(),
    });
    await expect(current.signal("SIGDOESNOTEXIST" as "SIGTERM")).rejects.toMatchObject({
      code: "unsupported_signal",
    });
    await current.terminateTree({ graceMs: 100 });
  });

  it("exposes filterEnvironment", () => {
    const source = { FOO: "bar", SECRET: "x", KEEP: "1" };
    expect(filterEnvironment(source, ["FOO", "KEEP"])).toEqual({
      FOO: "bar",
      KEEP: "1",
    });
    expect(filterEnvironment(source, undefined, ["SECRET"])).toEqual({
      FOO: "bar",
      KEEP: "1",
    });
    expect(filterEnvironment(source, [])).toEqual({});
    expect(filterEnvironment(source, ["FOO", "SECRET"], ["SECRET"])).toEqual({
      FOO: "bar",
    });
  });

  it("maps EACCES to permission_denied on POSIX", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = mkdtempSync(join(tmpdir(), "meguribi-process-"));
    const noExec = join(tmpDir, "no-exec");
    writeFileSync(noExec, "#!/usr/bin/env node\n", { mode: 0o644 });
    current = runner.run(noExec, [], { cwd: tmpDir });
    await expect(current.waitForExit()).rejects.toMatchObject({
      code: "permission_denied",
    });
    unlinkSync(noExec);
    rmdirSync(tmpDir);
  });
});

describe("Windows-specific taskkill behavior", () => {
  it("throws force_failed when taskkill is not available and can be retried", async () => {
    if (process.platform !== "win32") {
      return;
    }
    current = runner.run(node(), [fixture("ignore-sigterm.js")], {
      cwd: process.cwd(),
    });
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(current.terminateTree({ graceMs: 50 })).rejects.toMatchObject({
        code: "force_failed",
      });
      await expect(current.waitForExit()).rejects.toMatchObject({
        code: "force_failed",
      });
    } finally {
      process.env.PATH = originalPath ?? "";
    }
    const result = await current.terminateTree({ graceMs: 100 });
    expect(result).toBeDefined();
    await expect(current.waitForExit()).resolves.toBe(result);
  });
});
