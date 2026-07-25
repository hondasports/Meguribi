import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { AgentError, AgentErrorCode } from "@meguribi/core";

export type ProcessErrorCode =
  | "executable_not_found"
  | "timeout"
  | "cancelled"
  | "permission_denied"
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
  startedAt: string;
  finishedAt: string;
}

export interface TerminationOptions {
  graceMs?: number;
}

export interface ProcessRunnerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  envAllow?: string[];
  envDeny?: string[];
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  terminationGraceMs?: number;
}

export interface ManagedProcess {
  readonly pid: number;
  readonly startedAt: string;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  writeStdin(data: Uint8Array | string): Promise<void>;
  closeStdin(): Promise<void>;
  signal(kind: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void>;
  waitForExit(): Promise<ProcessExit>;
  terminateTree(options?: TerminationOptions): Promise<ProcessExit>;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}

export function toProcessError(error: Error, executable?: string): ProcessError {
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code === "ENOENT") {
    return new ProcessError(
      "executable_not_found",
      `Executable not found: ${executable ?? "unknown"}`,
      false,
    );
  }
  if (nodeError.code === "EACCES" || nodeError.code === "EPERM") {
    return new ProcessError(
      "permission_denied",
      `Permission denied: ${executable ?? "unknown"}`,
      false,
    );
  }
  if (nodeError.code === "ETIMEDOUT" || nodeError.message?.includes("timeout")) {
    return new ProcessError("timeout", error.message ?? "Timed out", true);
  }
  return new ProcessError("process_crashed", error.message ?? "Process crashed", false);
}

export function filterEnvironment(
  source: NodeJS.ProcessEnv,
  allow?: string[],
  deny?: string[],
): NodeJS.ProcessEnv {
  const denySet = new Set(deny ?? []);
  if (allow !== undefined) {
    const entries = allow
      .filter((key) => !denySet.has(key) && source[key] !== undefined)
      .map((key) => [key, source[key]!]);
    return Object.fromEntries(entries);
  }
  const entries = Object.entries(source).filter(([key]) => !denySet.has(key));
  return Object.fromEntries(entries);
}

export function toAgentError(error: ProcessError): AgentError {
  const codeMap: Record<ProcessErrorCode, AgentErrorCode> = {
    executable_not_found: "executable_not_found",
    timeout: "timeout",
    cancelled: "cancelled",
    permission_denied: "permission_denied",
    process_crashed: "process_crashed",
    force_failed: "cleanup_failed",
    unsupported_signal: "unsupported_signal",
    unknown: "unknown",
  };
  return {
    code: codeMap[error.code],
    message: error.message,
    isRetryable: error.isRetryable,
  };
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
    let settled = false;
    const onError = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      stream.off("error", onError);
      stream.off("drain", onDrain);
      reject(toProcessError(err));
    };
    const onDrain = () => {
      if (settled) {
        return;
      }
      settled = true;
      stream.off("error", onError);
      stream.off("drain", onDrain);
      resolve();
    };
    stream.once("error", onError);
    try {
      const canContinue = stream.write(data, (err) => {
        if (settled) {
          return;
        }
        if (err) {
          onError(err);
          return;
        }
        settled = true;
        stream.off("error", onError);
        stream.off("drain", onDrain);
        resolve();
      });
      if (!canContinue) {
        stream.once("drain", onDrain);
      }
    } catch (err) {
      onError(err as Error);
    }
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
  return isErrnoException(error) && error.code === "ESRCH";
}

function isUnsupportedSignalError(error: unknown, _kind: string): boolean {
  if (!isErrnoException(error)) {
    return false;
  }
  const code = error.code;
  const message = error.message?.toLowerCase() ?? "";
  return (
    code === "EINVAL" ||
    code === "ERR_UNKNOWN_SIGNAL" ||
    message.includes("unknown signal") ||
    message.includes("unsupported signal")
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isNoSuchProcessError(err)) {
      return false;
    }
    if (isErrnoException(err) && (err.code === "EPERM" || err.code === "EACCES")) {
      return true;
    }
    return false;
  }
}

function waitForProcessDeath(pid: number, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!isProcessAlive(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function sendGroupSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if (isNoSuchProcessError(err)) {
      return;
    }
    throw toProcessError(err as Error);
  }
}

function runTaskkill(pid: number, force: boolean): Promise<number | null> {
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
    killer.on("error", (err: Error) => {
      reject(new ProcessError("force_failed", `taskkill failed: ${err.message}`, false));
    });
    killer.on("close", (code: number | null) => {
      resolve(code);
    });
  });
}

async function terminateWindows(pid: number, graceMs: number): Promise<void> {
  const executeTaskkill = async (force: boolean): Promise<number | null> => {
    try {
      return await runTaskkill(pid, force);
    } catch (err) {
      if (await waitForProcessDeath(pid, graceMs)) {
        return null;
      }
      throw err;
    }
  };

  await executeTaskkill(false);
  if (await waitForProcessDeath(pid, graceMs)) {
    return;
  }

  const forceCode = await executeTaskkill(true);
  if (await waitForProcessDeath(pid, graceMs)) {
    return;
  }

  if (isProcessAlive(pid)) {
    throw new ProcessError(
      "force_failed",
      `Process ${pid} survived taskkill /T /F (exit code ${forceCode ?? "unknown"})`,
      false,
    );
  }
}

async function terminatePosix(pid: number, graceMs: number): Promise<void> {
  sendGroupSignal(pid, "SIGTERM");
  if (await waitForProcessDeath(-pid, graceMs)) {
    return;
  }

  sendGroupSignal(pid, "SIGKILL");
  if (await waitForProcessDeath(-pid, graceMs)) {
    return;
  }

  if (isProcessAlive(-pid)) {
    throw new ProcessError(
      "force_failed",
      `Process group ${pid} survived SIGTERM and SIGKILL`,
      false,
    );
  }
}

function buildEnvironment(options: ProcessRunnerOptions): NodeJS.ProcessEnv {
  const source = options.env ?? {};
  return filterEnvironment(source, options.envAllow, options.envDeny);
}

export class ProcessRunner {
  run(executable: string, args: string[], options: ProcessRunnerOptions): ManagedProcess {
    if (!options.cwd) {
      throw new ProcessError("executable_not_found", "cwd is required to run an executable", false);
    }
    if (options.abortSignal?.aborted) {
      throw new ProcessError("cancelled", "Process was cancelled before start", false);
    }

    const startedAt = new Date().toISOString();
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: buildEnvironment(options),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });

    let exit: ProcessExit | undefined;
    let spawnError: ProcessError | undefined;
    let settled = false;
    const waiters: Array<() => void> = [];

    let timeoutTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (abortHandler && options.abortSignal) {
        options.abortSignal.removeEventListener("abort", abortHandler);
      }
      notifyWaiters();
    };

    const notifyWaiters = () => {
      const pending = waiters.splice(0);
      for (const waiter of pending) {
        waiter();
      }
    };

    const waitForSettled = (): Promise<ProcessExit> => {
      if (settled) {
        if (spawnError) {
          return Promise.reject(spawnError);
        }
        return Promise.resolve(exit!);
      }
      if (spawnError) {
        return Promise.reject(spawnError);
      }
      return new Promise((resolve, reject) => {
        waiters.push(() => {
          if (spawnError) {
            reject(spawnError);
          } else if (exit) {
            resolve(exit);
          } else {
            reject(new ProcessError("unknown", "Process closed without exit information", false));
          }
        });
        if (settled) {
          notifyWaiters();
        }
      });
    };

    const waitForClose = (): Promise<ProcessExit> => {
      if (settled) {
        if (exit) {
          return Promise.resolve(exit);
        }
        return spawnError
          ? Promise.reject(spawnError)
          : Promise.reject(
              new ProcessError("unknown", "Process closed without exit information", false),
            );
      }
      return new Promise((resolve, reject) => {
        waiters.push(() => {
          if (exit) {
            resolve(exit);
          } else if (spawnError) {
            reject(spawnError);
          } else {
            reject(new ProcessError("unknown", "Process closed without exit information", false));
          }
        });
        if (settled) {
          notifyWaiters();
        }
      });
    };

    const terminateTree = async (terminationOptions?: TerminationOptions): Promise<ProcessExit> => {
      const graceMs = terminationOptions?.graceMs ?? options.terminationGraceMs ?? 5000;
      const pid = child.pid;
      if (pid === undefined || settled) {
        if (exit) {
          return exit;
        }
        return spawnError
          ? Promise.reject(spawnError)
          : Promise.reject(
              new ProcessError("unknown", "Process closed without exit information", false),
            );
      }

      try {
        if (process.platform === "win32") {
          await terminateWindows(pid, graceMs);
        } else {
          await terminatePosix(pid, graceMs);
        }
        return await waitForClose();
      } catch (terminationError) {
        if (settled || pid === undefined) {
          throw terminationError;
        }
        if (terminationError instanceof ProcessError) {
          spawnError = terminationError;
        } else {
          spawnError = toProcessError(terminationError as Error);
        }
        notifyWaiters();
        throw spawnError;
      }
    };

    const startTermination = async (error: ProcessError, graceMs: number): Promise<void> => {
      if (settled) {
        return;
      }
      spawnError = error;
      try {
        await terminateTree({ graceMs });
      } catch (terminationError) {
        if (settled || child.pid === undefined) {
          return;
        }
        if (terminationError instanceof ProcessError) {
          spawnError = terminationError;
        } else {
          spawnError = toProcessError(terminationError as Error);
        }
        notifyWaiters();
      }
    };

    child.on("error", (err: Error) => {
      if (settled) {
        return;
      }
      spawnError = toProcessError(err, executable);
      settle();
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      exit = {
        code,
        signal,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      if (spawnError?.code === "force_failed") {
        spawnError = undefined;
      }
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

    if (options.abortSignal) {
      abortHandler = () => {
        if (settled) {
          return;
        }
        const error = new ProcessError("cancelled", "Process was cancelled by caller", false);
        startTermination(error, options.terminationGraceMs ?? 5000).catch(() => {});
      };
      options.abortSignal.addEventListener("abort", abortHandler);
    }

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        const error = new ProcessError(
          "timeout",
          `Process timed out after ${options.timeoutMs}ms`,
          true,
        );
        startTermination(error, options.terminationGraceMs ?? 5000).catch(() => {});
      }, options.timeoutMs);
    }

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
        if (isNoSuchProcessError(err)) {
          return;
        }
        if (isUnsupportedSignalError(err, kind)) {
          throw new ProcessError("unsupported_signal", `Unsupported signal: ${kind}`, false);
        }
        throw toProcessError(err as Error);
      }
    };

    const waitForExit = (): Promise<ProcessExit> => waitForSettled();

    return {
      pid: child.pid,
      startedAt,
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
