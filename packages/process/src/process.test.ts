import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessError, ProcessRunner, type ManagedProcess } from "./index.js";

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
  it("exits successfully and captures stdout/stderr", async () => {
    current = runner.run(node(), [fixture("success.js")]);
    const [out, err, result] = await Promise.all([
      collect(current.stdout),
      collect(current.stderr),
      current.waitForExit(),
    ]);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(out).toContain("stdout-line");
    expect(err).toContain("stderr-line");
  });

  it("exits with a non-zero code", async () => {
    current = runner.run(node(), [fixture("exit-code.js"), "42"]);
    const result = await current.waitForExit();
    expect(result.code).toBe(42);
  });

  it("echoes stdin to stdout", async () => {
    current = runner.run(node(), [fixture("echo.js")]);
    await current.writeStdin("hello\n");
    await current.closeStdin();
    const out = await collect(current.stdout);
    const result = await current.waitForExit();
    expect(out).toBe("hello\n");
    expect(result.code).toBe(0);
  });

  it("times out waitForExit", async () => {
    current = runner.run(node(), [fixture("ignore-sigterm.js")]);
    await expect(current.waitForExit(100)).rejects.toThrow(ProcessError);
    await expect(current.waitForExit(100)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("terminates on SIGTERM", async () => {
    current = runner.run(node(), [fixture("cancel-listener.js")]);
    await current.signal("SIGTERM");
    const result = await current.waitForExit();
    expect(result.code === 0 || result.signal === "SIGTERM").toBe(true);
  });

  it("force terminates after SIGTERM is ignored", async () => {
    current = runner.run(node(), [fixture("ignore-sigterm.js")]);
    const pid = current.pid;
    await current.signal("SIGTERM");
    const result = await current.terminateTree({ graceMs: 100 });
    expect(result.signal ?? result.code).toBeTruthy();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("recovers process tree", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "meguribi-process-"));
    const pidFile = join(tmpDir, "child.pid");
    current = runner.run(node(), [fixture("spawn-child.js")], {
      env: { ...process.env, MEGURIBI_TEST_PID_FILE: pidFile },
    });
    await delay(300);
    const childPid = Number(readFileSync(pidFile, "utf-8"));
    await current.terminateTree({ graceMs: 100 });
    expect(() => process.kill(childPid, 0)).toThrow();
    unlinkSync(pidFile);
  });

  it("is idempotent for closeStdin and terminateTree", async () => {
    current = runner.run(node(), [fixture("ignore-sigterm.js")]);
    await current.closeStdin();
    await current.closeStdin();
    await current.terminateTree({ graceMs: 100 });
    await expect(current.terminateTree({ graceMs: 100 })).resolves.toBeDefined();
  });

  it("fails when executable is not found", () => {
    expect(() => runner.run("this-does-not-exist-executable", [])).toThrow(ProcessError);
    try {
      runner.run("this-does-not-exist-executable", []);
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessError);
      expect((err as ProcessError).code).toBe("executable_not_found");
    }
  });
});
