import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  let taskkillCalls = 0;
  return {
    ...mod,
    spawn: (...args: Parameters<typeof mod.spawn>) => {
      const [command] = args;
      if (command === "taskkill") {
        taskkillCalls++;
        if (taskkillCalls <= 2) {
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
  it("throws force_failed when taskkill exits with a non-zero code and can be retried", async () => {
    if (process.platform !== "win32") {
      return;
    }
    current = runner.run(node(), [fixture("ignore-sigterm.js")], {
      cwd: process.cwd(),
    });
    await expect(current.terminateTree({ graceMs: 50 })).rejects.toMatchObject({
      code: "force_failed",
      message: /exit code 1/,
    });
    await expect(current.waitForExit()).rejects.toMatchObject({
      code: "force_failed",
    });

    const result = await current.terminateTree({ graceMs: 100 });
    expect(result).toBeDefined();
    await expect(current.waitForExit()).resolves.toBe(result);
  });
});
