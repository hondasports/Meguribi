import { describe, expect, it } from "vitest";
import type { ManagedProcess, ProcessExit } from "@meguribi/process";
import { AcpProcessLifecycle } from "./transport.js";
import { DevinAcpTransportError } from "./transport-error.js";

function alreadyExitedProcess(exit: ProcessExit): Pick<ManagedProcess, "waitForExit"> {
  return {
    waitForExit: async () => exit,
  };
}

describe("AcpProcessLifecycle", () => {
  it("rejects awaitAliveOrCrash with process_crashed when already exited (no TDZ)", async () => {
    const lifecycle = new AcpProcessLifecycle(
      alreadyExitedProcess({
        code: 23,
        signal: null,
        startedAt: "2026-07-26T00:00:00.000Z",
        finishedAt: "2026-07-26T00:00:01.000Z",
      }),
    );
    // Flush the waitForExit().then handler so unexpectedError is set before subscribe.
    await Promise.resolve();
    await Promise.resolve();

    expect(lifecycle.unexpectedError).toBeInstanceOf(DevinAcpTransportError);

    await expect(lifecycle.awaitAliveOrCrash(500)).rejects.toMatchObject({
      code: "process_crashed",
      name: "DevinAcpTransportError",
    });
  });

  it("resolves awaitAliveOrCrash when the process stays alive for the window", async () => {
    let resolveExit!: (exit: ProcessExit) => void;
    const exitPromise = new Promise<ProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const lifecycle = new AcpProcessLifecycle({
      waitForExit: () => exitPromise,
    });

    await expect(lifecycle.awaitAliveOrCrash(30)).resolves.toBeUndefined();

    resolveExit({
      code: 0,
      signal: null,
      startedAt: "2026-07-26T00:00:00.000Z",
      finishedAt: "2026-07-26T00:00:02.000Z",
    });
    lifecycle.markIntentionalShutdown();
  });
});
