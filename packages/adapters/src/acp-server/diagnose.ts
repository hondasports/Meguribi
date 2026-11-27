import type {
  AgentDiagnosis,
  AgentProfile,
  DiagnosisError,
  DiagnosisWarning,
} from "@meguribi/core";
import { agentDisplayName } from "@meguribi/core";
import { createAcpTransport, type AcpTransport } from "../acp/transport.js";
import { AcpTransportError } from "../acp/transport-error.js";
import { redactDiagnosticText } from "../acp/redact.js";

export interface DiagnoseAcpServerOptions {
  profile: AgentProfile;
  executable: string;
  executableArgs?: string[];
  cwd: string;
  nonInteractive: boolean;
  probeTimeoutMs: number;
  transport?: AcpTransport;
  env?: NodeJS.ProcessEnv;
}

export class AcpServerNotRunnableError extends Error {
  constructor(public readonly diagnosis: AgentDiagnosis) {
    super(
      diagnosis.errors[0]?.message ??
        "ACP server is not runnable according to preflight diagnosis",
    );
    this.name = "AcpServerNotRunnableError";
  }
}

/**
 * 診断結果が runnable でなければ例外を投げる。run preflight 用。
 */
export function assertAcpServerRunnable(diagnosis: AgentDiagnosis): void {
  if (!diagnosis.runnable) {
    throw new AcpServerNotRunnableError(diagnosis);
  }
}

/**
 * kind ごとのインストール案内。standalone ACP サーバーとして配布される
 * Claude Code / Codex 用パッケージを案内する。
 */
export function acpServerInstallHint(profile: AgentProfile): string {
  if (profile.kind === "claude-code") {
    return "npm i -g @agentclientprotocol/claude-agent-acp";
  }
  if (profile.kind === "codex") {
    return "npm i -g @agentclientprotocol/codex-acp";
  }
  return `Install the ACP server executable for profile "${profile.id}" and ensure it is on PATH`;
}

function evaluateMcpPolicy(
  profile: AgentProfile,
  nonInteractive: boolean,
): { warnings: DiagnosisWarning[]; errors: DiagnosisError[] } {
  const warnings: DiagnosisWarning[] = [];
  const errors: DiagnosisError[] = [];

  warnings.push({
    code: "inherited_mcp",
    message:
      "Saved agent settings may include MCP servers. Meguribi cannot fully isolate MCP.",
  });

  if (profile.inheritedMcpPolicy === "warn" && nonInteractive) {
    errors.push({
      code: "policy_blocked",
      message:
        "inheritedMcpPolicy is warn, which is not allowed in non-interactive mode",
      nextAction:
        "Set inheritedMcpPolicy to allow or deny, or run interactively",
    });
  }

  return { warnings, errors };
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown ACP server probe failure";
  return redactDiagnosticText(message);
}

/**
 * 単体で ACP サーバーとして動くエージェント（claude-agent-acp / codex-acp 等）を
 * 実際に initialize + session 作成まで試して診断する。
 * version / auth の個別 probe は存在しないため、成功時も両方 unknown 扱いにする。
 */
export async function diagnoseAcpServer(
  options: DiagnoseAcpServerOptions,
): Promise<AgentDiagnosis> {
  const { profile } = options;
  const displayName = agentDisplayName(profile.kind);
  const errors: DiagnosisError[] = [];
  const warnings: DiagnosisWarning[] = [];

  const mcp = evaluateMcpPolicy(profile, options.nonInteractive);
  warnings.push(...mcp.warnings);
  errors.push(...mcp.errors);

  const provisional: AgentDiagnosis = {
    executable: { status: "ok", path: options.executable },
    version: { status: "unknown" },
    authentication: { status: "unknown" },
    acp: { status: "unknown" },
    inheritedMcpPolicy: profile.inheritedMcpPolicy,
    runnable: true,
    warnings: [],
    errors: [],
  };

  const finish = (
    overrides: Partial<AgentDiagnosis> & Pick<AgentDiagnosis, "executable" | "acp">,
  ): AgentDiagnosis => ({
    version: { status: "unknown" },
    authentication: { status: "unknown" },
    inheritedMcpPolicy: profile.inheritedMcpPolicy,
    runnable: false,
    warnings,
    errors,
    ...overrides,
  });

  const transport = options.transport ?? createAcpTransport();
  try {
    const connection = await transport.start({
      executable: options.executable,
      executableArgs: options.executableArgs,
      acpArgs: [],
      cwd: options.cwd,
      env: options.env,
      startupTimeoutMs: options.probeTimeoutMs,
      diagnosis: provisional,
      assertRunnable: () => {},
    });
    const supportsSessionLoad = connection.supportsSessionLoad;
    await connection.terminate(500).catch(() => undefined);

    warnings.push({
      code: "unknown_version",
      message: `${displayName} ACP server does not expose a version probe; treating version as unknown`,
    });
    warnings.push({
      code: "auth_unknown",
      message: `Could not determine ${displayName} authentication status`,
    });

    return finish({
      executable: { status: "ok", path: options.executable },
      acp: { status: "supported", supportsSessionLoad },
      runnable: errors.length === 0,
    });
  } catch (error) {
    if (error instanceof AcpTransportError) {
      if (error.code === "spawn_failure") {
        errors.push({
          code: "executable_not_found",
          message: `${displayName} ACP server executable not found: ${options.executable}`,
          nextAction: acpServerInstallHint(profile),
        });
        return finish({
          executable: { status: "missing" },
          acp: { status: "unknown" },
        });
      }
      if (error.code === "startup_timeout") {
        errors.push({
          code: "timeout",
          message: `Timed out while probing the ${displayName} ACP server`,
        });
        return finish({
          executable: { status: "ok", path: options.executable },
          acp: { status: "unknown" },
        });
      }
      if (
        error.code === "initialize_failure" ||
        error.code === "capability_mismatch" ||
        error.code === "session_creation_failure"
      ) {
        errors.push({
          code: "protocol_initialization_failure",
          message: safeMessage(error),
        });
        return finish({
          executable: { status: "ok", path: options.executable },
          acp: { status: "unsupported" },
        });
      }
      errors.push({
        code: error.toAgentError().code,
        message: safeMessage(error),
      });
      return finish({
        executable: { status: "ok", path: options.executable },
        acp: { status: "unknown" },
      });
    }
    errors.push({
      code: "unknown",
      message: safeMessage(error),
    });
    return finish({
      executable: { status: "ok", path: options.executable },
      acp: { status: "unknown" },
    });
  }
}
