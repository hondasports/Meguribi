import fs from "node:fs";
import path from "node:path";
import type { VerificationResult, Verifier } from "@meguribi/core";
import { ProcessError, ProcessRunner } from "@meguribi/process";

const SHELL_METACHARACTERS = /[&|<>^%]/;
export const DEFAULT_VERIFY_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Runs configured verify commands with explicit argv and `shell: false`.
 * Command strings are whitespace-split for simple `pnpm <script>` forms only.
 */
export function createCommandVerifier(options?: {
  runner?: ProcessRunner;
  /** Default per-command timeout when verify() omits timeoutMs. */
  timeoutMs?: number;
  resolveExecutable?: typeof resolvePlatformExecutable;
}): Verifier {
  const runner = options?.runner ?? new ProcessRunner();
  const defaultTimeoutMs = options?.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const resolveExecutable = options?.resolveExecutable ?? resolvePlatformExecutable;
  return {
    async verify(input): Promise<VerificationResult> {
      const commands: VerificationResult["commands"] = [];
      let success = true;
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      for (const command of input.commands) {
        if (input.abortSignal?.aborted) {
          throw cancelledError();
        }
        const startedAt = new Date().toISOString();
        const { executable, args } = parseVerifyCommand(command.run);
        const resolvedExecutable = resolveExecutable(executable);
        try {
          const child = runner.run(resolvedExecutable, args, {
            cwd: input.worktreePath,
            env: process.env,
            abortSignal: input.abortSignal,
            timeoutMs,
            terminationGraceMs: Math.min(5_000, Math.max(100, Math.floor(timeoutMs / 10))),
          });
          const [, , exit] = await Promise.all([
            drain(child.stdout),
            drain(child.stderr),
            child.waitForExit(),
          ]);
          const finishedAt = new Date().toISOString();
          if (exit.code !== 0) {
            success = false;
          }
          commands.push({
            name: command.name,
            exitCode: exit.code,
            startedAt,
            finishedAt,
          });
        } catch (error) {
          const finishedAt = new Date().toISOString();
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

async function drain(source: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of source) {
    // Discard output so full pipes cannot deadlock the child.
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
