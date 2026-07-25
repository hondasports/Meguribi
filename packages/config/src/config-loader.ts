import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import {
  devinConfigFromEnvironment,
  resolveDevinConfig,
  type DevinConfig,
  type DevinConfigInput,
} from "./devin-config.js";

export interface LoadDevinConfigOptions {
  userConfigPath?: string;
  repositoryPath?: string;
  environment?: NodeJS.ProcessEnv;
  cli?: unknown;
  nonInteractive?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export async function loadDevinConfig(options: LoadDevinConfigOptions): Promise<DevinConfig> {
  const repositoryConfigPath = options.repositoryPath
    ? path.join(options.repositoryPath, ".meguribi.yml")
    : undefined;
  return resolveDevinConfig({
    user: await readConfig(options.userConfigPath),
    repository: await readConfig(repositoryConfigPath),
    environment: devinConfigFromEnvironment(options.environment ?? process.env),
    cli: options.cli,
    nonInteractive: options.nonInteractive,
  });
}

export type { DevinConfigInput };
