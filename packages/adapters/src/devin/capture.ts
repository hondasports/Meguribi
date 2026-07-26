import type { ProcessExit, ProcessRunner } from "@meguribi/process";
import { ProcessError } from "@meguribi/process";

/** probe 1 本あたりの stdout+stderr 合計上限（バイト）。 */
export const DEFAULT_PROBE_OUTPUT_MAX_BYTES = 256 * 1024;

/**
 * 出力上限超過後に停止完了を待つ最大時間。
 * probe timeout 全体を使い切らず、残留プロセス待ちで永久待機しない。
 */
export const DEFAULT_OVERFLOW_STOP_TIMEOUT_MS = 2_000;

export interface CapturedCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  executableMissing: boolean;
  outputTooLarge: boolean;
  /** 上限超過後の停止に失敗した、または stop deadline に達した。 */
  stopFailed: boolean;
}

export class ProbeOutputTooLargeError extends Error {
  constructor(message = "Probe output exceeded size limit") {
    super(message);
    this.name = "ProbeOutputTooLargeError";
  }
}

export class ProbeStopFailedError extends Error {
  constructor(
    message = "Failed to stop probe process after output size limit",
  ) {
    super(message);
    this.name = "ProbeStopFailedError";
  }
}

function oversizedResult(
  maxOutputBytes: number,
  stopFailed: boolean,
): CapturedCommandResult {
  const reason = stopFailed
    ? `Probe output exceeded ${maxOutputBytes} bytes; process stop failed or timed out`
    : `Probe output exceeded ${maxOutputBytes} bytes`;
  return {
    exitCode: null,
    stdout: "",
    stderr: reason,
    timedOut: false,
    executableMissing: false,
    outputTooLarge: true,
    stopFailed,
  };
}

/**
 * AbortSignal で打ち切れる AsyncIterable 読み取り。
 * 子プロセスが生き残って EOF しない場合でも、deadline でループを抜けられる。
 */
async function* iterateUntilAbort(
  stream: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]();
  while (!signal.aborted) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: undefined }>((resolve) => {
        if (signal.aborted) {
          resolve({ done: true, value: undefined });
          return;
        }
        const onAbort = (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve({ done: true, value: undefined });
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (next.done) {
      break;
    }
    yield next.value;
  }
  // iterator.return() は呼ばない。永遠に pending な await 上で return すると
  // 環境によっては cleanup 自体が完了しなくなるため、abandon する。
}

/**
 * ProcessRunner 経由で短命コマンドを実行し、stdout/stderr を収集する。
 * 合計バイトが上限を超えたらプロセス停止を試み、bounded deadline 内に
 * 完了しなければ fail-closed で戻る（永久待機しない）。
 */
export async function captureCommand(
  runner: ProcessRunner,
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes?: number;
    /** 上限超過後の停止待ち上限。未指定時は {@link DEFAULT_OVERFLOW_STOP_TIMEOUT_MS}。 */
    overflowStopTimeoutMs?: number;
  },
): Promise<CapturedCommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PROBE_OUTPUT_MAX_BYTES;
  const overflowStopTimeoutMs =
    options.overflowStopTimeoutMs ?? DEFAULT_OVERFLOW_STOP_TIMEOUT_MS;

  try {
    const managed = runner.run(executable, args, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      terminationGraceMs: 200,
    });

    let totalBytes = 0;
    let outputTooLarge = false;
    let stopFailed = false;
    let overflowTimer: NodeJS.Timeout | undefined;
    const overflowAbort = new AbortController();

    const clearOverflowTimer = (): void => {
      if (overflowTimer !== undefined) {
        clearTimeout(overflowTimer);
        overflowTimer = undefined;
      }
    };

    const forceStopBestEffort = async (): Promise<void> => {
      try {
        await managed.signal("SIGKILL");
      } catch {
        stopFailed = true;
      }
      try {
        await managed.terminateTree({ graceMs: 0 });
      } catch {
        stopFailed = true;
      }
    };

    const armOverflowDeadline = (): void => {
      if (overflowTimer !== undefined || overflowAbort.signal.aborted) {
        return;
      }
      overflowTimer = setTimeout(() => {
        stopFailed = true;
        overflowAbort.abort();
        void forceStopBestEffort();
      }, overflowStopTimeoutMs);
    };

    const requestStopOnLimit = (): void => {
      if (outputTooLarge) {
        return;
      }
      outputTooLarge = true;
      armOverflowDeadline();
      // 読み取りループ内で terminate を await しない（close 待ちデッドロック回避）
      void managed.terminateTree({ graceMs: 0 }).then(
        () => {
          // 停止成功
        },
        () => {
          stopFailed = true;
        },
      );
    };

    const collectBounded = async (
      stream: AsyncIterable<Uint8Array>,
    ): Promise<string> => {
      const chunks: Uint8Array[] = [];
      let streamTotal = 0;
      for await (const chunk of iterateUntilAbort(stream, overflowAbort.signal)) {
        if (outputTooLarge) {
          continue;
        }
        totalBytes += chunk.byteLength;
        if (totalBytes > maxOutputBytes) {
          requestStopOnLimit();
          continue;
        }
        chunks.push(chunk);
        streamTotal += chunk.byteLength;
      }
      if (chunks.length === 0) {
        return "";
      }
      const merged = new Uint8Array(streamTotal);
      let offset = 0;
      for (const part of chunks) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      return new TextDecoder().decode(merged);
    };

    const exitPromise = new Promise<{
      ok: boolean;
      exit?: ProcessExit;
      error?: unknown;
    }>((resolve) => {
      const onAbort = (): void => {
        resolve({
          ok: false,
          error: new ProbeStopFailedError(
            `Probe stop timed out after ${overflowStopTimeoutMs}ms`,
          ),
        });
      };
      if (overflowAbort.signal.aborted) {
        onAbort();
        return;
      }
      overflowAbort.signal.addEventListener("abort", onAbort, { once: true });

      void managed.waitForExit().then(
        (exit) => {
          clearOverflowTimer();
          overflowAbort.signal.removeEventListener("abort", onAbort);
          resolve({ ok: true, exit });
        },
        (error: unknown) => {
          clearOverflowTimer();
          overflowAbort.signal.removeEventListener("abort", onAbort);
          if (outputTooLarge) {
            stopFailed = true;
          }
          resolve({ ok: false, error });
        },
      );
    });

    const [stdout, stderr, exitOutcome] = await Promise.all([
      collectBounded(managed.stdout),
      collectBounded(managed.stderr),
      exitPromise,
    ]);

    clearOverflowTimer();

    if (outputTooLarge) {
      return oversizedResult(maxOutputBytes, stopFailed || overflowAbort.signal.aborted);
    }

    if (!exitOutcome.ok) {
      throw exitOutcome.error;
    }

    return {
      exitCode: exitOutcome.exit?.code ?? null,
      stdout,
      stderr,
      timedOut: false,
      executableMissing: false,
      outputTooLarge: false,
      stopFailed: false,
    };
  } catch (error) {
    if (error instanceof ProcessError) {
      if (error.code === "executable_not_found") {
        return {
          exitCode: null,
          stdout: "",
          stderr: error.message,
          timedOut: false,
          executableMissing: true,
          outputTooLarge: false,
          stopFailed: false,
        };
      }
      if (error.code === "timeout") {
        return {
          exitCode: null,
          stdout: "",
          stderr: error.message,
          timedOut: true,
          executableMissing: false,
          outputTooLarge: false,
          stopFailed: false,
        };
      }
    }
    throw error;
  }
}
