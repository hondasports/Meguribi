import fs from "node:fs";
import path from "node:path";
import type { VerificationLogWriter, VerificationResult, Verifier } from "@meguribi/core";
import { ProcessError, ProcessRunner } from "@meguribi/process";
import { isSecretKey, redactDiagnosticText } from "../devin/redact.js";

const SHELL_METACHARACTERS = /[&|<>^%]/;
export const DEFAULT_VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_VERIFY_LOG_BYTES = 1_048_576;

/**
 * Runs configured verify commands with explicit argv and `shell: false`.
 * Command strings are whitespace-split for simple `pnpm <script>` forms only.
 */
export function createCommandVerifier(options?: {
  runner?: ProcessRunner;
  /** Default per-command timeout when verify() omits timeoutMs. */
  timeoutMs?: number;
  /** Maximum bytes retained per stdout/stderr stream before truncation. */
  maxLogBytes?: number;
  resolveExecutable?: typeof resolvePlatformExecutable;
}): Verifier {
  const runner = options?.runner ?? new ProcessRunner();
  const defaultTimeoutMs = options?.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const maxLogBytes = options?.maxLogBytes ?? DEFAULT_MAX_VERIFY_LOG_BYTES;
  assertPositiveInteger(defaultTimeoutMs, "verify timeout");
  assertPositiveInteger(maxLogBytes, "verify log size");
  const resolveExecutable = options?.resolveExecutable ?? resolvePlatformExecutable;
  return {
    async verify(input): Promise<VerificationResult> {
      const commands: VerificationResult["commands"] = [];
      let success = true;
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      assertPositiveInteger(timeoutMs, "verify timeout");
      for (const command of input.commands) {
        if (input.abortSignal?.aborted) {
          throw cancelledError();
        }
        const startedAt = new Date().toISOString();
        const { executable, args } = parseVerifyCommand(command.run);
        const resolvedExecutable = resolveExecutable(executable);
        let captured: { stdout: CollectedOutput; stderr: CollectedOutput } | undefined;
        try {
          const child = runner.run(resolvedExecutable, args, {
            cwd: input.worktreePath,
            env: process.env,
            abortSignal: input.abortSignal,
            timeoutMs,
            terminationGraceMs: Math.min(5_000, Math.max(100, Math.floor(timeoutMs / 10))),
          });
          const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
            collectOutput(child.stdout, maxLogBytes),
            collectOutput(child.stderr, maxLogBytes),
            child.waitForExit(),
          ]);
          const stdout = unwrapOutput(stdoutResult);
          const stderr = unwrapOutput(stderrResult);
          captured = { stdout, stderr };
          const exit = unwrapExit(exitResult);
          const finishedAt = new Date().toISOString();
          if (exit.code !== 0) {
            success = false;
          }
          const logPath = await writeLog(
            input.logWriter,
            command.name,
            commands.length,
            stdout,
            stderr,
          );
          commands.push({
            name: command.name,
            exitCode: exit.code,
            startedAt,
            finishedAt,
            ...(logPath ? { logPath } : {}),
          });
        } catch (error) {
          const finishedAt = new Date().toISOString();
          const logPath = await writeLog(
            input.logWriter,
            command.name,
            commands.length,
            captured?.stdout ?? { text: "", truncated: false },
            captured?.stderr ?? { text: "", truncated: false },
          );
          if (
            input.abortSignal?.aborted ||
            (error instanceof ProcessError && error.code === "cancelled")
          ) {
            throw cancelledError(error);
          }
          if (error instanceof ProcessError && error.code === "timeout") {
            success = false;
            commands.push({
              name: command.name,
              exitCode: null,
              startedAt,
              finishedAt,
              ...(logPath ? { logPath } : {}),
              timedOut: true,
            });
            break;
          }
          throw error;
        }
      }
      return {
        schemaVersion: 1,
        artifactType: "verification",
        success,
        commands,
      };
    },
  };
}

export function parseVerifyCommand(run: string): { executable: string; args: string[] } {
  const trimmed = run.trim();
  if (!trimmed) {
    throw new Error("Verify command must not be empty");
  }
  if (SHELL_METACHARACTERS.test(trimmed)) {
    throw new Error(`Verify command contains shell metacharacters: ${run}`);
  }
  const parts = trimmed.split(/\s+/);
  const executable = parts[0];
  if (!executable) {
    throw new Error("Verify command must not be empty");
  }
  return { executable, args: parts.slice(1) };
}

export interface ResolvePlatformExecutableOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
}

/**
 * Resolve a bare executable name using PATH + PATHEXT on Windows.
 * Does not blindly append `.cmd` (that would break `node` / `git`).
 */
export function resolvePlatformExecutable(
  executable: string,
  options: ResolvePlatformExecutableOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return executable;
  }
  if (/[\\/]/.test(executable) || path.extname(executable) !== "") {
    return executable;
  }

  const env = options.env ?? process.env;
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (value.startsWith(".") ? value : `.${value}`));
  const pathExists =
    options.pathExists ??
    ((candidate: string) => {
      try {
        fs.accessSync(candidate);
        return true;
      } catch {
        return false;
      }
    });

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(dir, `${executable}${extension}`);
      if (pathExists(candidate)) {
        return candidate;
      }
    }
  }
  return executable;
}

interface CollectedOutput {
  text: string;
  truncated: boolean;
}

async function collectOutput(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<CollectedOutput> {
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  for await (const chunk of source) {
    totalBytes += chunk.byteLength;
    if (retainedBytes >= maxBytes) {
      continue;
    }
    const retained = chunk.subarray(0, Math.min(chunk.byteLength, maxBytes - retainedBytes));
    chunks.push(retained);
    retainedBytes += retained.byteLength;
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  return { text, truncated: totalBytes > retainedBytes };
}

function unwrapOutput(
  result: PromiseSettledResult<CollectedOutput>,
): CollectedOutput {
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}

function unwrapExit(
  result: PromiseSettledResult<{ code: number | null; signal: string | null; startedAt: string; finishedAt: string }>,
): { code: number | null; signal: string | null; startedAt: string; finishedAt: string } {
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}

async function writeLog(
  writer: VerificationLogWriter | undefined,
  commandName: string,
  commandIndex: number,
  stdout: CollectedOutput | string,
  stderr: CollectedOutput | string,
): Promise<string | undefined> {
  if (!writer) {
    return undefined;
  }
  const stdoutOutput = typeof stdout === "string" ? { text: stdout, truncated: false } : stdout;
  const stderrOutput = typeof stderr === "string" ? { text: stderr, truncated: false } : stderr;
  const redactedStdout = redactVerifierOutput(stdoutOutput.text);
  const redactedStderr = redactVerifierOutput(stderrOutput.text);
  return writer.write({
    commandName,
    commandIndex,
    stdout: redactedStdout,
    stderr: redactedStderr,
    truncated: stdoutOutput.truncated || stderrOutput.truncated,
  });
}

function redactVerifierOutput(text: string): string {
  let redacted = redactDiagnosticText(text);
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 4 || !isSecretKey(key)) {
      continue;
    }
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value >= 2_147_483_647) {
    throw new Error(`${label} must be an integer between 1 and 2147483646`);
  }
}

function cancelledError(cause?: unknown): Error {
  return Object.assign(new Error("verification cancelled"), {
    code: "cancelled" as const,
    message: "verification cancelled",
    isRetryable: false,
    cause,
  });
}
