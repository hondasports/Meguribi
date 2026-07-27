import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runCommand(executable: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code: code ?? 1 };
      if (result.code === 0) {
        resolve(result);
      } else {
        reject(new Error(`${executable} ${args.join(" ")} failed (${result.code}): ${result.stderr}`));
      }
    });
  });
}

export async function gitChangedFiles(cwd: string): Promise<string[]> {
  const result = await runCommand("git", ["status", "--porcelain", "--untracked-files=all"], cwd);
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).sort();
}

export async function gitHead(cwd: string): Promise<string> {
  return (await runCommand("git", ["rev-parse", "HEAD"], cwd)).stdout.trim();
}
