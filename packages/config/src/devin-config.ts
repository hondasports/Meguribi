import * as v from "valibot";

// Node.js setTimeout uses a signed 32-bit integer for the delay, so values
// greater than or equal to 2^31 overflow to 1ms. We keep a small margin below
// that limit to avoid any platform-specific rounding issues.
const MAX_TIMEOUT_MS = 2_147_483_647 - 1;
const MAX_TIMEOUT_MINUTES = Math.floor(MAX_TIMEOUT_MS / 60_000);

const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const msTimeout = v.pipe(positiveInteger, v.maxValue(MAX_TIMEOUT_MS));
const minutesTimeout = v.pipe(positiveInteger, v.maxValue(MAX_TIMEOUT_MINUTES));

// Single executable path/name only. This allows spaces and colons in Windows
// and Unix paths while rejecting command templates and secret flags such as
// `devin acp` or `devin --token=SECRET`.
function isValidExecutable(value: string): boolean {
  if (value.trim() !== value) return false;
  if (value.startsWith("-")) return false;
  if (value.includes("://")) return false;

  // Command templates contain spaces; legitimate file paths may also contain
  // spaces in directory names. Distinguish them by requiring a path separator
  // when whitespace is present, rejecting any whitespace-separated token that
  // looks like a flag or secret assignment, and ensuring the final path segment
  // (the executable file name) does not contain spaces so "path arg" cannot
  // masquerade as a path.
  const whitespace = /\s/u;
  if (whitespace.test(value)) {
    if (!/[\\/]/.test(value)) return false;

    const lastSeparator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    const finalSegment = value.slice(lastSeparator + 1);
    if (whitespace.test(finalSegment)) return false;

    const tokens = value.split(/\s+/u);
    for (const token of tokens) {
      if (token.length === 0) continue;
      if (token.startsWith("-")) return false;
      if (token.includes("=")) return false;
    }
  }

  // Single-token secret assignments like `FOO=bar` are rejected unless the
  // value contains a path separator, which makes it a plausible path.
  if (!/[\\/]/.test(value) && value.includes("=")) return false;

  return true;
}

export const DevinConfigSchema = v.strictObject({
  executable: v.optional(v.pipe(v.string(), v.nonEmpty(), v.check(isValidExecutable, "Invalid executable"))),
  transport: v.optional(v.picklist(["acp"])),
  gracefulShutdownMs: v.optional(msTimeout),
  terminateTimeoutMs: v.optional(msTimeout),
  forceKillTimeoutMs: v.optional(msTimeout),
  startupTimeoutMs: v.optional(msTimeout),
  turnTimeoutMinutes: v.optional(minutesTimeout),
  inheritedMcpPolicy: v.optional(v.picklist(["warn", "allow", "deny"])),
});

export type DevinConfigInput = v.InferOutput<typeof DevinConfigSchema>;
export type InheritedMcpPolicy = NonNullable<DevinConfigInput["inheritedMcpPolicy"]>;

export interface DevinConfig {
  executable: string;
  transport: "acp";
  gracefulShutdownMs: number;
  terminateTimeoutMs: number;
  forceKillTimeoutMs: number;
  startupTimeoutMs: number;
  turnTimeoutMinutes: number;
  inheritedMcpPolicy: InheritedMcpPolicy;
}

export interface DevinConfigSources {
  user?: unknown;
  repository?: unknown;
  environment?: unknown;
  cli?: unknown;
  nonInteractive?: boolean;
}

export function devinConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const stringKeys = [
    ["MEGURIBI_DEVIN_EXECUTABLE", "executable"],
    ["MEGURIBI_DEVIN_TRANSPORT", "transport"],
    ["MEGURIBI_DEVIN_INHERITED_MCP_POLICY", "inheritedMcpPolicy"],
  ] as const;
  const numberKeys = [
    ["MEGURIBI_DEVIN_GRACEFUL_SHUTDOWN_MS", "gracefulShutdownMs"],
    ["MEGURIBI_DEVIN_TERMINATE_TIMEOUT_MS", "terminateTimeoutMs"],
    ["MEGURIBI_DEVIN_FORCE_KILL_TIMEOUT_MS", "forceKillTimeoutMs"],
    ["MEGURIBI_DEVIN_STARTUP_TIMEOUT_MS", "startupTimeoutMs"],
    ["MEGURIBI_DEVIN_TURN_TIMEOUT_MINUTES", "turnTimeoutMinutes"],
  ] as const;

  for (const [environmentKey, configKey] of stringKeys) {
    if (environment[environmentKey] !== undefined) {
      config[configKey] = environment[environmentKey];
    }
  }
  for (const [environmentKey, configKey] of numberKeys) {
    if (environment[environmentKey] !== undefined) {
      config[configKey] = Number(environment[environmentKey]);
    }
  }
  return config;
}

const defaults: DevinConfig = {
  executable: "devin",
  transport: "acp",
  gracefulShutdownMs: 2000,
  terminateTimeoutMs: 3000,
  forceKillTimeoutMs: 1000,
  startupTimeoutMs: 10000,
  turnTimeoutMinutes: 45,
  inheritedMcpPolicy: "warn",
};

function formatValidationError(issues: v.BaseIssue<unknown>[]): string {
  const fields = issues
    .map((issue) => issue.path?.map((item) => String(item.key)).join(".") ?? issue.message)
    .join(", ");
  return `Invalid Devin configuration: ${fields}`;
}

export function validateDevinConfig(input: unknown): DevinConfigInput {
  const result = v.safeParse(DevinConfigSchema, input);
  if (!result.success) {
    throw new Error(formatValidationError(result.issues));
  }
  return result.output;
}

export function resolveDevinConfig(sources: DevinConfigSources): DevinConfig {
  const user = validateDevinConfig(sources.user ?? {});
  const repository = validateDevinConfig(sources.repository ?? {});
  const environment = validateDevinConfig(sources.environment ?? {});
  const cli = validateDevinConfig(sources.cli ?? {});
  const config: DevinConfig = {
    ...defaults,
    ...user,
    ...repository,
    ...environment,
    ...cli,
  };

  if (sources.nonInteractive && config.inheritedMcpPolicy === "warn") {
    throw new Error(
      "Invalid Devin configuration: inheritedMcpPolicy must be allow or deny in non-interactive mode",
    );
  }

  return config;
}

const secretKeyPattern = /authorization|cookie|credential|key|password|secret|token/i;

function redact(value: unknown, key?: string): unknown {
  if (key !== undefined && secretKeyPattern.test(key)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)] as const)
        .filter(([, entryValue]) => entryValue !== undefined),
    );
  }
  return value;
}

export function toRedactedDevinConfigSnapshot(
  config: unknown,
): Record<string, unknown> {
  return redact(config) as Record<string, unknown>;
}
