import * as v from "valibot";

const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

export const DevinConfigSchema = v.strictObject({
  executable: v.optional(v.string()),
  transport: v.optional(v.picklist(["acp"])),
  gracefulShutdownMs: v.optional(positiveInteger),
  terminateTimeoutMs: v.optional(positiveInteger),
  forceKillTimeoutMs: v.optional(positiveInteger),
  startupTimeoutMs: v.optional(positiveInteger),
  turnTimeoutMinutes: v.optional(positiveInteger),
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
  config: Record<string, unknown>,
): Record<string, unknown> {
  return redact(config) as Record<string, unknown>;
}
