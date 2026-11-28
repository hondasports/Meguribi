import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DeskCommandOptions {
  port?: number;
}

export interface DeskStartInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type DeskStarter = (input: DeskStartInput) => Promise<number>;

export interface DeskCommandDependencies {
  start?: DeskStarter;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: (text: string) => void;
}

const DEFAULT_DESK_PORT = 4173;

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port: ${String(port)}`);
  }
}

function pnpmLaunch(): { command: string; argsPrefix: string[] } {
  if (process.platform !== "win32") return { command: "pnpm", argsPrefix: [] };
  return {
    command: process.execPath,
    argsPrefix: [
      path.join(path.dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js"),
    ],
  };
}

async function startDeskProcess(input: DeskStartInput): Promise<number> {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: "inherit",
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  });
}

export async function runDeskCommand(
  options: DeskCommandOptions = {},
  deps: DeskCommandDependencies = {},
): Promise<{ exitCode: number }> {
  const port = options.port ?? DEFAULT_DESK_PORT;
  validatePort(port);
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  writeOut(`Command Desk: http://127.0.0.1:${String(port)}\n`);
  const pnpm = pnpmLaunch();
  const exitCode = await (deps.start ?? startDeskProcess)({
    command: pnpm.command,
    args: [...pnpm.argsPrefix, "--filter", "@meguribi/web", "dev"],
    cwd: deps.cwd ?? repositoryRoot(),
    env: {
      ...(deps.env ?? process.env),
      MEGURIBI_WEB_PORT: String(port),
    },
  });
  return { exitCode };
}
