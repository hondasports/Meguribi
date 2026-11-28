import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AgentProfile } from "@meguribi/core";

export interface ResolvedAcpServerExecutable {
  executable: string;
  executableArgs: readonly string[];
  source: "bundled" | "configured" | "profile";
}

interface BundledBridge {
  profileId: string;
  executableName: string;
  packageName: string;
}

const BUNDLED_BRIDGES: Partial<Record<AgentProfile["kind"], BundledBridge>> = {
  "claude-code": {
    profileId: "claude-code",
    executableName: "claude-agent-acp",
    packageName: "@agentclientprotocol/claude-agent-acp",
  },
  codex: {
    profileId: "codex-acp",
    executableName: "codex-acp",
    packageName: "@agentclientprotocol/codex-acp",
  },
};

function bundledBridge(profile: AgentProfile): BundledBridge | undefined {
  const candidate = BUNDLED_BRIDGES[profile.kind];
  return candidate?.profileId === profile.id ? candidate : undefined;
}

function resolveBridgePackageJsonPath(bridge: BundledBridge): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve(`${bridge.packageName}/package.json`);
  } catch {
    return undefined;
  }
}

function resolveBundledScript(bridge: BundledBridge): string | undefined {
  try {
    const packageJsonPath = resolveBridgePackageJsonPath(bridge);
    if (packageJsonPath === undefined) return undefined;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const relativeBin =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin?.[bridge.executableName];
    if (relativeBin === undefined) return undefined;
    const script = path.join(path.dirname(packageJsonPath), relativeBin);
    return existsSync(script) ? script : undefined;
  } catch {
    return undefined;
  }
}

export interface ResolvedAcpServerMainCli {
  executable: string;
  executableArgs: readonly string[];
  versionArgs: readonly string[];
  authArgs: readonly string[];
  authFormat: "claude-json" | "codex-text";
  executableEnvVar: "CLAUDE_CODE_EXECUTABLE" | "CODEX_PATH";
}

function usesBundledBridge(profile: AgentProfile, bridge: BundledBridge): boolean {
  return profile.executable === undefined || profile.executable === bridge.executableName;
}

export function resolveAcpServerMainCli(
  profile: AgentProfile,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAcpServerMainCli | undefined {
  const bridge = bundledBridge(profile);
  if (bridge === undefined || !usesBundledBridge(profile, bridge)) return undefined;
  if (profile.kind === "claude-code") {
    return {
      executable: env.CLAUDE_CODE_EXECUTABLE ?? "claude",
      executableArgs: [],
      versionArgs: ["--version"],
      authArgs: ["auth", "status"],
      authFormat: "claude-json",
      executableEnvVar: "CLAUDE_CODE_EXECUTABLE",
    };
  }
  if (profile.kind === "codex") {
    return {
      executable: env.CODEX_PATH ?? "codex",
      executableArgs: [],
      versionArgs: ["--version"],
      authArgs: ["login", "status"],
      authFormat: "codex-text",
      executableEnvVar: "CODEX_PATH",
    };
  }
  return undefined;
}
export function resolveAcpServerExecutable(profile: AgentProfile): ResolvedAcpServerExecutable {
  const configured = profile.executable;
  const bridge = bundledBridge(profile);
  if (
    bridge !== undefined &&
    usesBundledBridge(profile, bridge)
  ) {
    const script = resolveBundledScript(bridge);
    if (script !== undefined) {
      return {
        executable: process.execPath,
        executableArgs: [script],
        source: "bundled",
      };
    }
  }
  if (configured !== undefined) {
    return { executable: configured, executableArgs: [], source: "configured" };
  }
  return { executable: profile.id, executableArgs: [], source: "profile" };
}
