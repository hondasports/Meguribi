import { describe, expect, it } from "vitest";
import type { ManagedProcess, ProcessRunner } from "@meguribi/process";
import { ProcessError } from "@meguribi/process";
import {
  captureCommand,
  DEFAULT_OVERFLOW_STOP_TIMEOUT_MS,
} from "./capture.js";

function encoder(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function hangingStream(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<{ done: true; value: undefined }>(() => {
            // never resolves — open pipe with no data
          }),
        return: async () => ({ done: true as const, value: undefined }),
      };
    },
  };
}

async function* floodStdout(): AsyncGenerator<Uint8Array> {
  // 上限を超える塊を出したあと、EOF しない（残留プロセス相当）
  yield encoder("A".repeat(4096));
  await new Promise(() => {
    // never resolves
  });
}

function createUnkilledFloodRunner(): ProcessRunner {
  const managed: ManagedProcess = {
    pid: 4242,
    startedAt: new Date().toISOString(),
    stdout: floodStdout(),
    stderr: hangingStream(),
    writeStdin: async () => {},
    closeStdin: async () => {},
    signal: async () => {
      throw new ProcessError("force_failed", "signal failed", false);
    },
    waitForExit: () =>
      new Promise(() => {
        // process never exits
      }),
    terminateTree: async () => {
      throw new ProcessError(
        "force_failed",
        "Process group survived SIGTERM and SIGKILL",
        false,
      );
    },
  };

  return {
    run: () => managed,
  } as ProcessRunner;
}

describe("captureCommand overflow stop deadline", () => {
  it("returns fail-closed when terminate fails and process never exits", async () => {
    const started = Date.now();
    const result = await captureCommand(
      createUnkilledFloodRunner(),
      "fake-devin",
      ["--version"],
      {
        cwd: process.cwd(),
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
        overflowStopTimeoutMs: 80,
      },
    );
    const elapsed = Date.now() - started;

    expect(result.outputTooLarge).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.executableMissing).toBe(false);
    expect(result.stopFailed).toBe(true);
    expect(result.stderr).toMatch(/stop failed|stop timed out/i);
    // probe timeout (30s) まで待たず、overflow deadline 付近で戻る
    expect(elapsed).toBeLessThan(5_000);
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it("exposes a default overflow stop timeout under the usual probe timeout", () => {
    expect(DEFAULT_OVERFLOW_STOP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_OVERFLOW_STOP_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
