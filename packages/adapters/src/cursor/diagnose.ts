import type {
  DiagnosisError,
  DiagnosisWarning,
  AgentDiagnosis,
  InheritedMcpPolicy,
} from "@meguribi/core";
import type { ProcessRunner } from "@meguribi/process";
import { ProcessRunner as DefaultProcessRunner } from "@meguribi/process";
import { parseAcpCapability } from "./acp.js";
import { parseAuthStatus } from "./auth.js";
import { captureCommand } from "../acp/capture.js";
import { redactDiagnosticText, sanitizeDiagnosticDisplayText } from "../acp/redact.js";
import {
  compareSemver,
  parseCursorVersionOutput,
  parseMinimumVersion,
} from "./version.js";

/**
 * doctor / run preflight が使う最低対応 Cursor CLI version。
 * Cursor ACP の安定版が未確定なので、とりあえず 0.0.0 を floor とする。
 */
export const MINIMUM_SUPPORTED_CURSOR_CLI_VERSION = "0.0.0";

export interface DiagnoseCursorOptions {
  executable: string;
  /**
   * executable の直後に付与する固定引数。
   * fake `node script.js` やラッパー起動用。本番の `cursor` では通常不要。
   */
  executableArgs?: string[];
  inheritedMcpPolicy: InheritedMcpPolicy;
  /** 非対話実行。warn ポリシーは fail-closed にする。 */
  nonInteractive?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  probeTimeoutMs?: number;
  /**
   * 最低対応 version。未指定時は {@link MINIMUM_SUPPORTED_CURSOR_CLI_VERSION}。
   * 空文字や不正値は拒否する（floor 無効化は許可しない）。
   */
  minimumSupportedVersion?: string;
  runner?: ProcessRunner;
}

export class InvalidMinimumSupportedVersionError extends Error {
  constructor(value: string) {
    super(`Invalid minimumSupportedVersion: ${value}`);
    this.name = "InvalidMinimumSupportedVersionError";
  }
}

function resolveMinimumSupportedVersion(input: string | undefined): string {
  const source = input ?? MINIMUM_SUPPORTED_CURSOR_CLI_VERSION;
  if (source.trim().length === 0) {
    throw new InvalidMinimumSupportedVersionError(JSON.stringify(source));
  }
  const parsed = parseMinimumVersion(source);
  if (!parsed) {
    throw new InvalidMinimumSupportedVersionError(source);
  }
  return source.trim();
}

const FALLBACK_CURSOR_EXECUTABLES = ["cursor-agent", "agent"];

interface ResolveCursorExecutableInput {
  runner: ProcessRunner;
  executable: string;
  executableArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

async function resolveCursorExecutable(
  input: ResolveCursorExecutableInput,
): Promise<{ executable: string; prefix: string[] } | undefined> {
  const { runner, executable, executableArgs, cwd, env, timeoutMs } = input;
  const candidates = [
    executable,
    ...FALLBACK_CURSOR_EXECUTABLES.filter((candidate) => candidate !== executable),
  ];

  for (const candidate of candidates) {
    const prefix = candidate === executable ? executableArgs : [];
    const probe = await captureCommand(
      runner,
      candidate,
      [...prefix, "acp", "--help"],
      { cwd, env, timeoutMs },
    );
    if (probe.executableMissing) {
      continue;
    }
    if (probe.timedOut || probe.outputTooLarge) {
      continue;
    }
    const status = parseAcpCapability({
      acpHelp: probe.stdout || probe.stderr,
      acpExitCode: probe.exitCode,
      timedOut: probe.timedOut || probe.outputTooLarge,
    });
    if (status === "supported") {
      return { executable: candidate, prefix };
    }
  }

  return undefined;
}

function resolveVersionStatus(
  rawStdout: string,
  minimumSupportedVersion: string,
): AgentDiagnosis["version"] {
  const parsed = parseCursorVersionOutput(rawStdout);
  const safeRaw = parsed.raw
    ? sanitizeDiagnosticDisplayText(redactDiagnosticText(parsed.raw))
    : undefined;
  if (!parsed.parseable || parsed.major === undefined) {
    return { status: "unknown", raw: safeRaw || undefined };
  }
  const minimum = parseMinimumVersion(minimumSupportedVersion);
  if (
    minimum &&
    parsed.minor !== undefined &&
    parsed.patch !== undefined &&
    compareSemver(
      { major: parsed.major, minor: parsed.minor, patch: parsed.patch },
      minimum,
    ) < 0
  ) {
    return { status: "unsupported", raw: safeRaw };
  }
  return { status: "supported", raw: safeRaw };
}

function evaluateMcpPolicy(
  policy: InheritedMcpPolicy,
  nonInteractive: boolean,
): { blocked: boolean; warnings: DiagnosisWarning[]; errors: DiagnosisError[] } {
  const warnings: DiagnosisWarning[] = [];
  const errors: DiagnosisError[] = [];

  warnings.push({
    code: "inherited_mcp",
    message:
      "Saved agent settings may include MCP servers. Meguribi cannot fully isolate MCP.",
  });

  if (policy === "warn" && nonInteractive) {
    errors.push({
      code: "policy_blocked",
      message:
        "inheritedMcpPolicy is warn, which is not allowed in non-interactive mode",
      nextAction:
        "Set inheritedMcpPolicy to allow or deny, or run interactively",
    });
    return { blocked: true, warnings, errors };
  }

  return { blocked: false, warnings, errors };
}

/**
 * Cursor CLI の executable / version / auth / ACP / MCP ポリシーを診断する。
 */
export async function diagnoseCursor(
  options: DiagnoseCursorOptions,
): Promise<AgentDiagnosis> {
  const runner = options.runner ?? new DefaultProcessRunner();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? { ...process.env };
  const timeoutMs = options.probeTimeoutMs ?? 5000;
  const nonInteractive = options.nonInteractive ?? false;
  const requestedExecutable = options.executable;
  const requestedExecutableArgs = options.executableArgs ?? [];
  const minimumSupportedVersion = resolveMinimumSupportedVersion(
    options.minimumSupportedVersion,
  );
  const errors: DiagnosisError[] = [];
  const warnings: DiagnosisWarning[] = [];

  const mcp = evaluateMcpPolicy(options.inheritedMcpPolicy, nonInteractive);
  warnings.push(...mcp.warnings);
  errors.push(...mcp.errors);

  const resolved = await resolveCursorExecutable({
    runner,
    executable: requestedExecutable,
    executableArgs: requestedExecutableArgs,
    cwd,
    env,
    timeoutMs,
  });

  if (resolved === undefined) {
    errors.push({
      code: "executable_not_found",
      message: `No supported Cursor ACP executable found. Tried: ${requestedExecutable}, cursor-agent, agent`,
      nextAction: "Install Cursor CLI and ensure it is on PATH, or set cursor.executable",
    });
    return {
      executable: { status: "missing" },
      version: { status: "unknown" },
      authentication: { status: "unknown" },
      acp: { status: "unknown" },
      inheritedMcpPolicy: options.inheritedMcpPolicy,
      runnable: false,
      warnings,
      errors,
    };
  }

  const prefix = resolved.prefix;
  const executable = {
    status: "ok" as const,
    path: resolved.executable,
  };

  const versionProbe = await captureCommand(
    runner,
    resolved.executable,
    [...prefix, "--version"],
    {
      cwd,
      env,
      timeoutMs,
    },
  );

  let version = resolveVersionStatus(versionProbe.stdout, minimumSupportedVersion);
  let probeTimedOut = false;
  let probeFailed = false;

  if (versionProbe.outputTooLarge) {
    errors.push({
      code: "process_crashed",
      message: "Cursor version probe produced oversized output",
    });
    return {
      executable,
      version: { status: "unknown" },
      authentication: { status: "unknown" },
      acp: { status: "unknown" },
      inheritedMcpPolicy: options.inheritedMcpPolicy,
      runnable: false,
      warnings,
      errors,
    };
  }

  if (versionProbe.timedOut) {
    probeTimedOut = true;
    version = { status: "unknown", raw: version.raw };
    errors.push({
      code: "timeout",
      message: "Timed out while probing Cursor version",
    });
    return {
      executable,
      version,
      authentication: { status: "unknown" },
      acp: { status: "unknown" },
      inheritedMcpPolicy: options.inheritedMcpPolicy,
      runnable: false,
      warnings,
      errors,
    };
  }

  if (versionProbe.exitCode !== 0) {
    version = { status: "unknown", raw: version.raw };
    errors.push({
      code: "process_crashed",
      message: "Cursor version probe exited unsuccessfully",
      nextAction: "Verify the Cursor CLI install and rerun `cursor --version`",
    });
    return {
      executable,
      version,
      authentication: { status: "unknown" },
      acp: { status: "unknown" },
      inheritedMcpPolicy: options.inheritedMcpPolicy,
      runnable: false,
      warnings,
      errors,
    };
  }

  if (version.status === "unknown") {
    warnings.push({
      code: "unknown_version",
      message: "Cursor version string could not be parsed; requiring ACP capability probe",
    });
  } else if (version.status === "unsupported") {
    errors.push({
      code: "unsupported_version",
      message: `Cursor version is unsupported: ${version.raw ?? ""}`,
      nextAction: `Upgrade Cursor CLI to ${minimumSupportedVersion} or later`,
    });
  }

  const authProbe = await captureCommand(
    runner,
    resolved.executable,
    [...prefix, "auth", "status"],
    { cwd, env, timeoutMs },
  );
  // stdout/stderr は判定後に捨て、redacted 文言のみエラーへ載せる
  let authentication: AgentDiagnosis["authentication"] = {
    status: parseAuthStatus({
      exitCode: authProbe.exitCode,
      stdout: authProbe.stdout,
      stderr: authProbe.stderr,
      timedOut: authProbe.timedOut || authProbe.outputTooLarge,
    }),
  };
  if (authProbe.outputTooLarge) {
    probeFailed = true;
    authentication = { status: "unknown" };
    errors.push({
      code: "process_crashed",
      message: "Cursor authentication probe produced oversized output",
    });
  } else if (authProbe.timedOut) {
    probeTimedOut = true;
    errors.push({
      code: "timeout",
      message: "Timed out while probing Cursor authentication",
    });
  } else if (authentication.status === "unauthenticated") {
    errors.push({
      code: "unauthenticated",
      message: "Cursor CLI is not authenticated",
      nextAction: `Run: ${resolved.executable} auth login`,
    });
  } else if (authentication.status === "unknown") {
    const statusProbe = await captureCommand(
      runner,
      resolved.executable,
      [...prefix, "status"],
      { cwd, env, timeoutMs },
    );
    if (!statusProbe.outputTooLarge && !statusProbe.timedOut) {
      authentication = {
        status: parseAuthStatus({
          exitCode: statusProbe.exitCode,
          stdout: statusProbe.stdout,
          stderr: statusProbe.stderr,
          timedOut: false,
        }),
      };
    }
    if (authentication.status === "unknown") {
      warnings.push({
        code: "auth_unknown",
        message: "Could not determine Cursor authentication status",
      });
    }
  }

  const acpHelpProbe = await captureCommand(
    runner,
    resolved.executable,
    [...prefix, "acp", "--help"],
    { cwd, env, timeoutMs },
  );
  const rootHelpProbe = await captureCommand(
    runner,
    resolved.executable,
    [...prefix, "--help"],
    {
      cwd,
      env,
      timeoutMs,
    },
  );

  const acpProbeDegraded =
    acpHelpProbe.timedOut ||
    rootHelpProbe.timedOut ||
    acpHelpProbe.outputTooLarge ||
    rootHelpProbe.outputTooLarge;

  if (acpHelpProbe.outputTooLarge || rootHelpProbe.outputTooLarge) {
    probeFailed = true;
    errors.push({
      code: "process_crashed",
      message: "Cursor ACP capability probe produced oversized output",
    });
  }

  if (acpHelpProbe.timedOut || rootHelpProbe.timedOut) {
    probeTimedOut = true;
    errors.push({
      code: "timeout",
      message: "Timed out while probing Cursor ACP capability",
    });
  }

  // signal 終了（exitCode === null）は成功扱いにしない
  if (
    acpHelpProbe.exitCode === null &&
    !acpHelpProbe.timedOut &&
    !acpHelpProbe.outputTooLarge
  ) {
    probeFailed = true;
    errors.push({
      code: "process_crashed",
      message: "Cursor ACP capability probe terminated abnormally",
    });
  }

  const acp = {
    status: parseAcpCapability({
      rootHelp: rootHelpProbe.stdout,
      rootHelpExitCode: rootHelpProbe.exitCode,
      acpHelp: acpHelpProbe.stdout || acpHelpProbe.stderr,
      acpExitCode: acpHelpProbe.exitCode,
      timedOut: acpProbeDegraded,
    }),
  };

  if (acp.status === "unsupported") {
    errors.push({
      code: "capability_missing",
      message: "Cursor ACP subcommand is not available",
      nextAction: "Upgrade Cursor CLI to a version that supports `cursor acp`",
    });
  } else if (acp.status === "unknown") {
    warnings.push({
      code: "acp_unknown",
      message: "Could not confirm Cursor ACP support from help output",
    });
  }

  const runnable =
    executable.status === "ok" &&
    version.status !== "unsupported" &&
    authentication.status === "authenticated" &&
    acp.status === "supported" &&
    !mcp.blocked &&
    !probeTimedOut &&
    !probeFailed;

  return {
    executable,
    version,
    authentication,
    acp,
    inheritedMcpPolicy: options.inheritedMcpPolicy,
    runnable,
    warnings,
    errors,
  };
}

export class CursorNotRunnableError extends Error {
  constructor(public readonly diagnosis: AgentDiagnosis) {
    super(
      diagnosis.errors[0]?.message ??
        "Cursor CLI is not runnable according to preflight diagnosis",
    );
    this.name = "CursorNotRunnableError";
  }
}

/**
 * 診断結果が runnable でなければ例外を投げる。run preflight 用。
 */
export function assertCursorRunnable(diagnosis: AgentDiagnosis): void {
  if (!diagnosis.runnable) {
    throw new CursorNotRunnableError(diagnosis);
  }
}

/**
 * `meguribi run` が呼ぶ preflight 入口。
 * 診断を実行し、runnable でなければ {@link CursorNotRunnableError} を投げる。
 */
export async function preflightCursor(
  options: DiagnoseCursorOptions,
): Promise<AgentDiagnosis> {
  const diagnosis = await diagnoseCursor(options);
  assertCursorRunnable(diagnosis);
  return diagnosis;
}
