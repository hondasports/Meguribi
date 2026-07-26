import { describe, expect, it, vi } from "vitest";
import { DevinAcpShutdownController } from "./shutdown.js";

function connection(overrides: Partial<{
  cancel: () => Promise<void>;
  closeInput: () => Promise<void>;
  waitForProcessExit: (timeoutMs?: number) => Promise<{ code: number | null; signal: null; startedAt: string; finishedAt: string }>;
  terminate: (graceMs?: number) => Promise<{ code: number | null; signal: null; startedAt: string; finishedAt: string; forceKillUsed?: boolean }>;
}> = {}) {
  return {
    cancel: vi.fn(async () => undefined),
    closeInput: vi.fn(async () => undefined),
    waitForProcessExit: vi.fn(async () => ({ code: 0, signal: null, startedAt: "a", finishedAt: "b" })),
    terminate: vi.fn(async () => ({ code: 0, signal: null, startedAt: "a", finishedAt: "b", forceKillUsed: true })),
    ...overrides,
  };
}

describe("DevinAcpShutdownController", () => {
  it("runs cancel, stdin close, and escalation exactly once", async () => {
    const c = connection({ waitForProcessExit: vi.fn(async () => { throw new Error("still alive"); }) });
    const controller = new DevinAcpShutdownController(c);
    const first = await controller.shutdown("timed_out", { gracefulShutdownMs: 1, terminateTimeoutMs: 1 });
    const second = await controller.shutdown("completed", { gracefulShutdownMs: 1, terminateTimeoutMs: 1 });
    expect(first).toMatchObject({ cancelSent: true, stdinClosed: true, terminateSent: true, forceKillUsed: true, residualProcesses: 0 });
    expect(second).toEqual(first);
    expect(c.cancel).toHaveBeenCalledTimes(1);
    expect(c.terminate).toHaveBeenCalledTimes(1);
  });

  it("records cleanup failure and does not report a clean process", async () => {
    const c = connection({
      waitForProcessExit: vi.fn(async () => { throw new Error("still alive"); }),
      terminate: vi.fn(async () => { throw new Error("cannot terminate"); }),
    });
    const result = await new DevinAcpShutdownController(c).shutdown("cancelled", { gracefulShutdownMs: 1, terminateTimeoutMs: 1 });
    expect(result.cleanupError?.code).toBe("cleanup_failed");
    expect(result.residualProcesses).toBe(1);
  });
});
