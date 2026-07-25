import * as v from "valibot";

// Node.js setTimeout uses a signed 32-bit integer for the delay, so values
// greater than or equal to 2^31 overflow to 1ms. We keep a small margin below
// that limit to avoid any platform-specific rounding issues.
const MAX_TIMEOUT_MS = 2_147_483_647 - 1;
const MAX_TIMEOUT_MINUTES = Math.floor(MAX_TIMEOUT_MS / 60_000);

const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const msTimeout = v.pipe(positiveInteger, v.maxValue(MAX_TIMEOUT_MS));
const minutesTimeout = v.pipe(positiveInteger, v.maxValue(MAX_TIMEOUT_MINUTES));

const allowedExecutableChars = /^[A-Za-z0-9_\-./\\~:()\s]+$/u;

function isValidExecutableBase(value: string): boolean {
  if (value.trim() !== value) return false;
  if (value.startsWith("-")) return false;
  if (value.includes("://")) return false;
  if (value.includes("=")) return false;
  if (!allowedExecutableChars.test(value)) return false;
  return true;
}

// Single executable path/name only, without spaces. This rejects command
// templates and secret flags for the simple string form.
function isValidExecutableString(value: string): boolean {
  if (!isValidExecutableBase(value)) return false;
  if (/\s/u.test(value)) return false;
  return true;
}

// Used for the one-element tuple form, which is the only way to represent an
// executable path that contains spaces. The whole element is the executable
// path; additional tuple elements (command arguments) are rejected by the
// schema shape itself.
function isValidExecutablePath(value: string): boolean {
  if (!isValidExecutableBase(value)) return false;

  // A tuple element with whitespace must contain a path separator; otherwise it
  // is a bare command template such as `devin acp`.
  if (/\s/u.test(value) && !/[\\/]/.test(value)) return false;

  // Reject any whitespace-separated token that looks like a flag, secret
  // assignment, or relative-path argument embedded in the path string.
  const tokens = value.split(/\s+/u);
  const separator = /[\\/]/u;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.length === 0) continue;
    if (token.startsWith("-")) return false;
    if (token.includes("=")) return false;
    if (/^(\.\/|\.\\|\.\.\/|\.\.\\)/u.test(token)) return false;

    // In a spaced path the first and last token must contain a path separator.
    // Intermediate tokens may be space-only segments like `Files` in
    // `C:\Program Files (x86)\Devin\devin.exe`, but a bare trailing argument
    // such as `acp` in `/usr/local/bin/devin acp` has no separator and is
    // therefore rejected.
    if ((index === 0 || index === tokens.length - 1) && !separator.test(token)) {
      return false;
    }
  }

  return true;
}

const executableSchema = v.optional(
  v.union([
    v.pipe(
      v.string(),
      v.nonEmpty(),
      v.check(isValidExecutableString, "Invalid executable"),
    ),
    v.strictTuple([
      v.pipe(
        v.string(),
        v.nonEmpty(),
        v.check(isValidExecutablePath, "Invalid executable"),
      ),
    ]),
  ]),
);

export const DevinConfigSchema = v.strictObject({
  executable: executableSchema,
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

  // MEGURIBI_DEVIN_EXECUTABLE accepts either a plain executable name/path
  // (no spaces) or an explicit JSON one-element string array for paths that
  // contain spaces. Plain strings with whitespace are not auto-converted, so
  // command templates such as `devin acp` cannot masquerade as a spaced path.
  const executable = environment.MEGURIBI_DEVIN_EXECUTABLE;
  if (executable !== undefined) {
    const trimmed = executable.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error(
          "Invalid executable in MEGURIBI_DEVIN_EXECUTABLE: value must be a valid JSON one-element string array",
        );
      }
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 1 ||
        typeof parsed[0] !== "string" ||
        parsed[0].length === 0
      ) {
        throw new Error(
          "Invalid executable in MEGURIBI_DEVIN_EXECUTABLE: value must be a JSON one-element string array",
        );
      }
      config.executable = [parsed[0]];
      assertValidExecutableValue(config.executable);
    } else {
      config.executable = executable;
      assertValidExecutableValue(config.executable);
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

function assertValidExecutableValue(value: unknown): void {
  if (typeof value === "string") {
    if (!isValidExecutableString(value)) {
      throw new Error("Invalid executable in MEGURIBI_DEVIN_EXECUTABLE");
    }
    return;
  }
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
    if (!isValidExecutablePath(value[0])) {
      throw new Error("Invalid executable in MEGURIBI_DEVIN_EXECUTABLE");
    }
    return;
  }
  throw new Error("Invalid executable in MEGURIBI_DEVIN_EXECUTABLE");
}

function normalizeDevinConfigInput(input: DevinConfigInput): Partial<DevinConfig> {
  const { executable, ...rest } = input;
  const result: Partial<DevinConfig> = { ...rest };
  if (executable !== undefined) {
    result.executable = Array.isArray(executable) ? executable[0] : executable;
  }
  return result;
}

export function resolveDevinConfig(sources: DevinConfigSources): DevinConfig {
  const user = normalizeDevinConfigInput(validateDevinConfig(sources.user ?? {}));
  const repository = normalizeDevinConfigInput(
    validateDevinConfig(sources.repository ?? {}),
  );
  const environment = normalizeDevinConfigInput(
    validateDevinConfig(sources.environment ?? {}),
  );
  const cli = normalizeDevinConfigInput(validateDevinConfig(sources.cli ?? {}));
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
