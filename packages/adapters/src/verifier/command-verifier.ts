import path from "node:path";
import type { VerificationResult, Verifier } from "@meguribi/core";
import { ProcessError, ProcessRunner } from "@meguribi/process";

const SHELL_METACHARACTERS = /[&|<>^%]/;

/**
 * Runs configured verify commands with explicit argv and `shell: false`.
 * Command strings are whitespace-split for simple `pnpm <script>` forms only.
 */
export function createCommandVerifier(options?: {
  runner?: ProcessRunner;
}): Verifier {
  const runner = options?.runner ?? new ProcessRunner();
  return {
    async verify(input): Promise<VerificationResult> {
      const commands: VerificationResult["commands"] = [];
      let success = true;
      for (const command of input.commands) {
        if (input.abortSignal?.aborted) {
          throw cancelledError();
        }
        const startedAt = new Date().toISOString();
        const { executable, args } = parseVerifyCommand(command.run);
        const resolvedExecutable = resolvePlatformExecutable(executable);
        let exitCode: number | null;
        try {
          const child = runner.run(resolvedExecutable, args, {
            cwd: input.worktreePath,
            env: process.env,
            abortSignal: input.abortSignal,
          });
          const [, , exit] = await Promise.all([
            drain(child.stdout),
            drain(child.stderr),
            child.waitForExit(),
          ]);
          exitCode = exit.code;
        } catch (error) {
          if (
            input.abortSignal?.aborted ||
            (error instanceof ProcessError && error.code === "cancelled")
          ) {
            throw cancelledError(error);
          }
          throw error;
        }
        const finishedAt = new Date().toISOString();
        if (exitCode !== 0) {
          success = false;
        }
        commands.push({
          name: command.name,
          exitCode,
          startedAt,
          finishedAt,
        });
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

function resolvePlatformExecutable(executable: string): string {
  if (
    process.platform === "win32" &&
    !/[\\/]/.test(executable) &&
    path.extname(executable) === ""
  ) {
    return `${executable}.cmd`;
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
