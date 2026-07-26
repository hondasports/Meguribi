import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import {
  cursorConfigFromEnvironment,
  resolveCursorConfig,
  toRedactedCursorConfigSnapshot,
  type CursorConfig,
  type CursorConfigInput,
  type CursorConfigSources,
} from "./cursor-config.js";
import {
  devinConfigFromEnvironment,
  resolveDevinConfig,
  toRedactedDevinConfigSnapshot,
  type DevinConfig,
  type DevinConfigInput,
  type DevinConfigSources,
} from "./devin-config.js";

export interface LoadDevinConfigOptions {
  userConfigPath?: string;
  repositoryPath?: string;
  environment?: NodeJS.ProcessEnv;
  cli?: unknown;
  nonInteractive?: boolean;
}

export interface DevinConfigResult {
  config: DevinConfig;
  snapshot: Record<string, unknown>;
}

export interface CursorConfigResult {
  config: CursorConfig;
  snapshot: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getDefaultUserConfigPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  const xdgConfigHome = environment.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return pathModule.join(xdgConfigHome, "meguribi", "config.yml");
  }
  if (platform === "win32") {
    // APPDATA may be an empty string; prefer the first non-empty value.
    const appData = environment.APPDATA || environment.LOCALAPPDATA;
    if (appData) {
      return pathModule.join(appData, "meguribi", "config.yml");
    }
  }
  // HOME may be an empty string; prefer the first non-empty value.
  const home = environment.HOME || environment.USERPROFILE;
  if (home) {
    return pathModule.join(home, ".config", "meguribi", "config.yml");
  }
  throw new Error("Could not determine user configuration directory");
}

function extractDevinConfig(document: unknown, source: string): unknown {
  if (document === null || document === undefined) {
    return {};
  }
  if (!isRecord(document)) {
    throw new Error(`Invalid configuration document: ${source}`);
  }
  if (document.devin === undefined) {
    return {};
  }
  if (!isRecord(document.devin)) {
    throw new Error(`Invalid Devin configuration: ${source}`);
  }
  return document.devin;
}

function extractCursorConfig(document: unknown, source: string): unknown {
  if (document === null || document === undefined) {
    return {};
  }
  if (!isRecord(document)) {
    throw new Error(`Invalid configuration document: ${source}`);
  }
  if (document.cursor === undefined) {
    return {};
  }
  if (!isRecord(document.cursor)) {
    throw new Error(`Invalid Cursor configuration: ${source}`);
  }
  return document.cursor;
}

async function readRawConfig(pathname: string | undefined): Promise<unknown> {
  if (pathname === undefined) {
    return {};
  }
  try {
    const content = await readFile(pathname, "utf8");
    return parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function readConfig(pathname: string | undefined): Promise<unknown> {
  if (pathname === undefined) {
    return {};
  }
  try {
    const content = await readFile(pathname, "utf8");
    return extractDevinConfig(parse(content), pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function loadDevinConfig(options: LoadDevinConfigOptions): Promise<DevinConfigResult> {
  const environment = options.environment ?? process.env;
  const userConfigPath = options.userConfigPath ?? getDefaultUserConfigPath(environment);
  const repositoryConfigPath = options.repositoryPath
    ? path.join(options.repositoryPath, ".meguribi.yml")
    : undefined;

  const user = await readConfig(userConfigPath);
  const repository = await readConfig(repositoryConfigPath);
  const environmentConfig = devinConfigFromEnvironment(environment);
  const cli = options.cli;

  const sources: DevinConfigSources = {
    user,
    repository,
    environment: environmentConfig,
    cli,
    nonInteractive: options.nonInteractive,
  };

  const config = resolveDevinConfig(sources);
  const snapshot = toRedactedDevinConfigSnapshot(config);

  return { config, snapshot };
}

export async function loadCursorConfig(options: LoadDevinConfigOptions): Promise<CursorConfigResult> {
  const environment = options.environment ?? process.env;
  const userConfigPath = options.userConfigPath ?? getDefaultUserConfigPath(environment);
  const repositoryConfigPath = options.repositoryPath
    ? path.join(options.repositoryPath, ".meguribi.yml")
    : undefined;

  const user = await readRawConfig(userConfigPath).then((raw) =>
    extractCursorConfig(raw, userConfigPath),
  );
  const repository = await readRawConfig(repositoryConfigPath).then((raw) =>
    extractCursorConfig(raw, repositoryConfigPath ?? "repository"),
  );
  const environmentConfig = cursorConfigFromEnvironment(environment);
  const cli = extractCursorConfig(options.cli, "cli");

  const sources: CursorConfigSources = {
    user,
    repository,
    environment: environmentConfig,
    cli,
    nonInteractive: options.nonInteractive,
  };

  const config = resolveCursorConfig(sources);
  const snapshot = toRedactedCursorConfigSnapshot(config);

  return { config, snapshot };
}

export type ImplementerConfigResult =
  | { kind: "devin"; config: DevinConfig; snapshot: Record<string, unknown> }
  | { kind: "cursor"; config: CursorConfig; snapshot: Record<string, unknown> };

export async function loadImplementerConfig(
  options: LoadDevinConfigOptions,
): Promise<ImplementerConfigResult> {
  const environment = options.environment ?? process.env;
  const userConfigPath = options.userConfigPath ?? getDefaultUserConfigPath(environment);
  const repositoryConfigPath = options.repositoryPath
    ? path.join(options.repositoryPath, ".meguribi.yml")
    : undefined;

  const userRaw = await readRawConfig(userConfigPath);
  const repositoryRaw = await readRawConfig(repositoryConfigPath);

  const cli = isRecord(options.cli) ? options.cli : {};
  const explicitImplementer =
    (cli.implementer as string | undefined) ?? environment.MEGURIBI_IMPLEMENTER;
  if (explicitImplementer === "cursor") {
    const result = await loadCursorConfig(options);
    return { kind: "cursor", ...result };
  }
  if (explicitImplementer === "devin") {
    const result = await loadDevinConfig(options);
    return { kind: "devin", ...result };
  }

  const cliHasCursor = cli.cursor !== undefined;
  const envHasCursor = environment.MEGURIBI_CURSOR_EXECUTABLE !== undefined;
  const repoHasCursor = isRecord(repositoryRaw) && repositoryRaw.cursor !== undefined;
  const userHasCursor = isRecord(userRaw) && userRaw.cursor !== undefined;

  if (cliHasCursor || envHasCursor || repoHasCursor || userHasCursor) {
    const result = await loadCursorConfig(options);
    return { kind: "cursor", ...result };
  }

  const result = await loadDevinConfig(options);
  return { kind: "devin", ...result };
}

export type { DevinConfigInput, CursorConfigInput };
