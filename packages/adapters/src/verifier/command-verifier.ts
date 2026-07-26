import { spawn } from "node:child_process";
import type { VerificationResult, Verifier } from "@meguribi/core";

/**
 * Runs configured verify commands as shell-free argv via `cmd.exe`/`sh -c` is avoided:
 * each command string is executed with the platform shell only when explicitly one string.
 * For MVP wiring we split on spaces for simple `pnpm <script>` commands.
 */
export function createCommandVerifier(): Verifier {
  return {
    async verify(input): Promise<VerificationResult> {
      const commands: VerificationResult["commands"] = [];
      let success = true;
      for (const command of input.commands) {
        const startedAt = new Date().toISOString();
        const parts = command.run.trim().split(/\s+/);
        const executable = parts[0] ?? command.run;
        const args = parts.slice(1);
        const exitCode = await new Promise<number | null>((resolve) => {
          // On Windows, package managers are often `.cmd` shims; allow shell only there.
          const child = spawn(executable, args, {
            cwd: input.worktreePath,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            shell: process.platform === "win32",
          });
          child.on("error", () => resolve(127));
          child.on("exit", (code) => resolve(code));
        });
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
