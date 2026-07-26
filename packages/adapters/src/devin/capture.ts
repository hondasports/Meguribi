import type { ProcessRunner } from "@meguribi/process";
import { ProcessError } from "@meguribi/process";

/** probe 1 本あたりの stdout+stderr 合計上限（バイト）。 */
export const DEFAULT_PROBE_OUTPUT_MAX_BYTES = 256 * 1024;

export interface CapturedCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  executableMissing: boolean;
  outputTooLarge: boolean;
}

export class ProbeOutputTooLargeError extends Error {
  constructor(message = "Probe output exceeded size limit") {
    super(message);
    this.name = "ProbeOutputTooLargeError";
  }
}

function oversizedResult(maxOutputBytes: number): CapturedCommandResult {
  return {
    exitCode: null,
    stdout: "",
    stderr: `Probe output exceeded ${maxOutputBytes} bytes`,
    timedOut: false,
    executableMissing: false,
    outputTooLarge: true,
  };
}

/**
 * ProcessRunner 経由で短命コマンドを実行し、stdout/stderr を収集する。
 * 合計バイトが上限を超えたらプロセスを停止して fail-closed にする。
 *
 * 注意: ストリーム読み取り中に terminateTree を await すると、
 * Windows などで close 待ちと読み取りがデッドロックするため、
 * 上限超過時は terminate を fire-and-forget し、EOF まで読み捨てる。
 * Linux では terminate が force_failed でも、上限超過なら fail-closed として扱う。
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
  },
): Promise<CapturedCommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PROBE_OUTPUT_MAX_BYTES;
  try {
    const managed = runner.run(executable, args, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      terminationGraceMs: 200,
    });

    let totalBytes = 0;
    let outputTooLarge = false;

    const requestStopOnLimit = (): void => {
      if (outputTooLarge) {
        return;
      }
      outputTooLarge = true;
      // await しない（読み取りループ内での close 待ちデッドロック回避）
      void managed.terminateTree({ graceMs: 0 }).catch(() => {});
    };

    const collectBounded = async (
      stream: AsyncIterable<Uint8Array>,
    ): Promise<string> => {
      const chunks: Uint8Array[] = [];
      let streamTotal = 0;
      for await (const chunk of stream) {
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

    // terminate 失敗（force_failed 等）で waitForExit が reject しても、
    // 上限超過済みなら fail-closed として扱う。
    const exitPromise = managed.waitForExit().then(
      (exit) => ({ ok: true as const, exit }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const [stdout, stderr, exitOutcome] = await Promise.all([
      collectBounded(managed.stdout),
      collectBounded(managed.stderr),
      exitPromise,
    ]);

    if (outputTooLarge) {
      return oversizedResult(maxOutputBytes);
    }

    if (!exitOutcome.ok) {
      throw exitOutcome.error;
    }

    return {
      exitCode: exitOutcome.exit.code,
      stdout,
      stderr,
      timedOut: false,
      executableMissing: false,
      outputTooLarge: false,
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
        };
      }
    }
    throw error;
  }
}
