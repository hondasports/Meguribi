import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const SAFE_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "ComSpec",
  "LANG",
  "LOCALAPPDATA",
  "Path",
  "PATH",
  "PATHEXT",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME"
]);
const SAFE_EXPLICIT_ENVIRONMENT_KEYS = new Set(["FAKE_ACP_MODE"]);

export function safeAgentEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENVIRONMENT_KEYS.has(key) && value !== undefined) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (SAFE_EXPLICIT_ENVIRONMENT_KEYS.has(key) && value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

export function spawnProcess(executable: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): ChildProcess {
  return spawn(executable, args, {
    cwd,
    env: safeAgentEnvironment(env),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

export async function waitForExit(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return { code, signal };
}

export async function terminateProcess(child: ChildProcess, graceMs: number): Promise<ChildExit> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  const result = await Promise.race([
    waitForExit(child),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), graceMs))
  ]);
  if (result) {
    return result;
  }

  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore"
    });
    await waitForExit(killer);
  } else {
    child.kill("SIGKILL");
  }
  return waitForExit(child);
}
