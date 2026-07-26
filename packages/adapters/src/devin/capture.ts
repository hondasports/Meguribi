import type { ProcessRunner } from "@meguribi/process";
import { ProcessError } from "@meguribi/process";

export interface CapturedCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  executableMissing: boolean;
}

async function collectText(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return "";
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * ProcessRunner 経由で短命コマンドを実行し、stdout/stderr を収集する。
 */
export async function captureCommand(
  runner: ProcessRunner,
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<CapturedCommandResult> {
  try {
    const managed = runner.run(executable, args, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      terminationGraceMs: 200,
    });
    const [stdout, stderr, exit] = await Promise.all([
      collectText(managed.stdout),
      collectText(managed.stderr),
      managed.waitForExit(),
    ]);
    return {
      exitCode: exit.code,
      stdout,
      stderr,
      timedOut: false,
      executableMissing: false,
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
        };
      }
      if (error.code === "timeout") {
        return {
          exitCode: null,
          stdout: "",
          stderr: error.message,
          timedOut: true,
          executableMissing: false,
        };
      }
    }
    throw error;
  }
}
