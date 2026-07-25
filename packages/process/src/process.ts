import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export type ProcessErrorCode =
  | "executable_not_found"
  | "timeout"
  | "cancelled"
  | "process_crashed"
  | "force_failed"
  | "unsupported_signal"
  | "unknown";

export class ProcessError extends Error {
  constructor(
    public readonly code: ProcessErrorCode,
    message: string,
    public readonly isRetryable: boolean = false,
  ) {
    super(message);
  }
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface TerminationOptions {
  graceMs?: number;
}

export interface ProcessRunnerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ManagedProcess {
  readonly pid: number;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  writeStdin(data: Uint8Array | string): Promise<void>;
  closeStdin(): Promise<void>;
  signal(kind: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<ProcessExit>;
  terminateTree(options?: TerminationOptions): Promise<ProcessExit>;
}

function toProcessError(error: Error, executable?: string): ProcessError {
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code === "ENOENT") {
    return new ProcessError(
      "executable_not_found",
      `Executable not found: ${executable ?? "unknown"}`,
      false,
    );
  }
  if (nodeError.code === "ETIMEDOUT" || nodeError.message?.includes("timeout")) {
    return new ProcessError("timeout", error.message ?? "Timed out", true);
  }
  return new ProcessError("process_crashed", error.message ?? "Process crashed", false);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* readStream(stream: Readable | null): AsyncGenerator<Uint8Array> {
  if (!stream) {
    return;
  }
  for await (const chunk of stream) {
    yield chunk as Uint8Array;
  }
}

function writeToStream(stream: Writable, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (err) => {
      if (err) {
        reject(toProcessError(err));
      } else {
        resolve();
      }
    });
  });
}

function closeStream(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) {
      resolve();
      return;
    }
    stream.end(() => resolve());
    stream.on("error", (err: Error) => {
      reject(toProcessError(err));
    });
  });
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "ESRCH"
  );
}

function runTaskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) {
      args.push("/F");
    }
    const killer = spawn("taskkill", args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", (err: Error) => reject(toProcessError(err)));
    killer.on("close", (code: number | null) => {
      if (code === 0 || code === 128) {
        resolve();
      } else {
        reject(
          new ProcessError("force_failed", `taskkill exited with ${code ?? "unknown"}`, false),
        );
      }
    });
  });
}

export class ProcessRunner {
  run(executable: string, args: string[], options?: ProcessRunnerOptions): ManagedProcess {
    const child = spawn(executable, args, {
      cwd: options?.cwd,
      env: options?.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });

    let exit: ProcessExit | undefined;
    let spawnError: ProcessError | undefined;
    let settled = false;
    const waiters: Array<() => void> = [];

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      for (const waiter of waiters) {
        waiter();
      }
      waiters.length = 0;
    };

    child.on("error", (err: Error) => {
      if (settled) {
        return;
      }
      spawnError = toProcessError(err, executable);
      settle();
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      exit = { code, signal };
      settle();
    });

    if (child.pid === undefined) {
      throw new ProcessError(
        "executable_not_found",
        `Failed to spawn executable: ${executable}`,
        false,
      );
    }

    const stdout = readStream(child.stdout);
    const stderr = readStream(child.stderr);

    const waitForExit = (timeoutMs?: number): Promise<ProcessExit> => {
      if (settled) {
        if (spawnError) {
          return Promise.reject(spawnError);
        }
        if (exit) {
          return Promise.resolve(exit);
        }
      }
      return new Promise((resolve, reject) => {
        const timer =
          timeoutMs !== undefined
            ? setTimeout(() => {
                reject(
                  new ProcessError("timeout", `waitForExit timed out after ${timeoutMs}ms`, true),
                );
              }, timeoutMs)
            : undefined;
        waiters.push(() => {
          if (timer) {
            clearTimeout(timer);
          }
          if (spawnError) {
            reject(spawnError);
          } else if (exit) {
            resolve(exit);
          }
        });
        if (settled) {
          settle();
        }
      });
    };

    const signal = async (kind: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void> => {
      if (settled || child.pid === undefined) {
        return;
      }
      let signalToSend: NodeJS.Signals = kind;
      if (process.platform === "win32" && kind === "SIGINT") {
        signalToSend = "SIGTERM";
      }
      try {
        child.kill(signalToSend);
      } catch (err) {
        if (settled) {
          return;
        }
        throw toProcessError(err as Error);
      }
    };

    const terminateTree = async (terminationOptions?: TerminationOptions): Promise<ProcessExit> => {
      const graceMs = terminationOptions?.graceMs ?? 5000;
      const pid = child.pid;
      if (pid === undefined || settled) {
        return waitForExit(0);
      }

      if (process.platform === "win32") {
        try {
          await runTaskkill(pid, false);
        } catch {
          // process may already be gone
        }
        await delay(graceMs);
        if (!settled) {
          try {
            await runTaskkill(pid, true);
          } catch {
            // process may already be gone
          }
        }
        return waitForExit(graceMs);
      }

      try {
        process.kill(-pid, "SIGTERM");
      } catch (err) {
        if (isNoSuchProcessError(err)) {
          return waitForExit(0);
        }
        throw toProcessError(err as Error);
      }

      await delay(graceMs);
      if (settled) {
        return waitForExit(0);
      }

      try {
        process.kill(-pid, "SIGKILL");
      } catch (err) {
        if (isNoSuchProcessError(err)) {
          return waitForExit(0);
        }
        throw toProcessError(err as Error);
      }

      return waitForExit(graceMs);
    };

    return {
      pid: child.pid,
      stdout,
      stderr,
      writeStdin: async (data: Uint8Array | string) => {
        if (child.stdin === null) {
          throw new ProcessError("process_crashed", "stdin is not available", false);
        }
        const buffer = typeof data === "string" ? Buffer.from(data) : data;
        await writeToStream(child.stdin, buffer);
      },
      closeStdin: async () => {
        if (child.stdin === null || child.stdin.destroyed) {
          return;
        }
        await closeStream(child.stdin);
      },
      signal,
      waitForExit,
      terminateTree,
    };
  }
}
