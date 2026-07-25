import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return {
    ...mod,
    spawn: (...args: Parameters<typeof mod.spawn>) => {
      const [command] = args;
      const taskArgs = args[1] ?? [];
      if (command === "taskkill") {
        const forceFail = process.env.__TASKKILL_FORCE_FAIL === "1";
        const isForce = taskArgs.includes("/F");
        if (!isForce || forceFail) {
          return mod.spawn(process.execPath, ["-e", "process.exit(1)"], {
            windowsHide: true,
            stdio: "ignore",
          });
        }
      }
      return mod.spawn(...args);
    },
  };
});

import { ProcessRunner, type ManagedProcess } from "./index.js";

const runner = new ProcessRunner();

function node(): string {
  return process.execPath;
}

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

let current: ManagedProcess | undefined;

beforeEach(() => {
  delete process.env.__TASKKILL_FORCE_FAIL;
});

afterEach(async () => {
  if (current) {
    try {
      await current.terminateTree({ graceMs: 100 });
    } catch {
      // ignore cleanup failures between tests
    }
    current = undefined;
  }
});

describe("Windows-specific taskkill behavior", () => {
  it("throws force_failed when both taskkill attempts exit non-zero and can be retried", async () => {
    if (process.platform !== "win32") {
      return;
    }
    current = runner.run(node(), [fixture("ignore-sigterm.js")], {
      cwd: process.cwd(),
    });
    process.env.__TASKKILL_FORCE_FAIL = "1";
    await expect(current.terminateTree({ graceMs: 50 })).rejects.toMatchObject({
      code: "force_failed",
      message: /exit/,
    });
    await expect(current.waitForExit()).rejects.toMatchObject({
      code: "force_failed",
    });

    delete process.env.__TASKKILL_FORCE_FAIL;
    const result = await current.terminateTree({ graceMs: 100 });
    expect(result).toBeDefined();
    await expect(current.waitForExit()).resolves.toBe(result);
  });

  it("succeeds when graceful taskkill exits non-zero but force succeeds", async () => {
    if (process.platform !== "win32") {
      return;
    }
    current = runner.run(node(), [fixture("ignore-sigterm.js")], {
      cwd: process.cwd(),
    });
    const result = await current.terminateTree({ graceMs: 100 });
    expect(result).toBeDefined();
    await expect(current.waitForExit()).resolves.toBe(result);
  });
});
