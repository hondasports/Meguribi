import { Command, Option } from "commander";
import {
  diagnoseCursor,
  diagnoseDevin,
  formatCursorDiagnosisHuman,
  formatDevinDiagnosisHuman,
  MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
  MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
} from "@meguribi/adapters";
import { loadImplementerConfig } from "@meguribi/config";
import type { AgentDiagnosis, DeliveryDependencies } from "@meguribi/core";
import { AgentDiagnosisSchema } from "@meguribi/schemas";
import * as v from "valibot";
import {
  runResumeCommand,
  runRunCommand,
  type DeliveryCommandDependencies,
  type DeliveryCommandOptions,
} from "./commands/run.js";

export interface DoctorCommandOptions {
  json?: boolean;
  nonInteractive?: boolean;
  implementer?: string;
}

export interface DoctorDependencies {
  diagnoseDevin?: typeof diagnoseDevin;
  diagnoseCursor?: typeof diagnoseCursor;
  formatDevinDiagnosisHuman?: typeof formatDevinDiagnosisHuman;
  formatCursorDiagnosisHuman?: typeof formatCursorDiagnosisHuman;
  loadConfig?: typeof loadImplementerConfig;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface ProgramDependencies extends DoctorDependencies, DeliveryCommandDependencies {
  delivery?: DeliveryDependencies;
}

export async function runDoctor(
  options: DoctorCommandOptions,
  deps: DoctorDependencies = {},
): Promise<{ exitCode: number; diagnosis: AgentDiagnosis }> {
  const loadConfig = deps.loadConfig ?? loadImplementerConfig;
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const cwd = deps.cwd ?? process.cwd();

  const config = await loadConfig({
    repositoryPath: cwd,
    // 曖昧な MCP ポリシーは diagnose 側で構造化して返す。
    // config loader の nonInteractive throw には乗せない。
    nonInteractive: false,
    cli: options,
  });

  let diagnosis: AgentDiagnosis;
  if (config.kind === "cursor") {
    diagnosis = await (deps.diagnoseCursor ?? diagnoseCursor)({
      executable: config.config.executable,
      inheritedMcpPolicy: config.config.inheritedMcpPolicy,
      nonInteractive: options.nonInteractive ?? false,
      cwd,
      probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
      minimumSupportedVersion: MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
    });
  } else {
    diagnosis = await (deps.diagnoseDevin ?? diagnoseDevin)({
      executable: config.config.executable,
      inheritedMcpPolicy: config.config.inheritedMcpPolicy,
      nonInteractive: options.nonInteractive ?? false,
      cwd,
      probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
      minimumSupportedVersion: MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
    });
  }

  const validated = v.parse(AgentDiagnosisSchema, diagnosis);

  if (options.json) {
    writeOut(`${JSON.stringify(validated, null, 2)}\n`);
  } else {
    const formatHuman =
      config.kind === "cursor"
        ? (deps.formatCursorDiagnosisHuman ?? formatCursorDiagnosisHuman)
        : (deps.formatDevinDiagnosisHuman ?? formatDevinDiagnosisHuman);
    writeOut(formatHuman(validated));
  }

  return {
    exitCode: validated.runnable ? 0 : 1,
    diagnosis: validated,
  };
}

function deliveryFlags(command: Command): Command {
  return command
    .option("--json", "Emit DeliveryResult JSON on stdout", false)
    .option("--non-interactive", "Fail closed on ambiguous MCP policy", false)
    .option("--implementer <kind>", "Implementer agent kind (devin or cursor)")
    .option("--allow-inherited-mcp", "Explicitly allow inherited MCP under warn policy", false)
    .option(
      "--max-fix-attempts <number>",
      "Maximum Devin fix attempts",
      (value) => {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`Invalid --max-fix-attempts: ${value}`);
        }
        return parsed;
      },
      2,
    )
    .addOption(new Option("--no-commit", "Skip git commit after successful review"))
    .addOption(new Option("--no-push", "Skip git push after commit"))
    .addOption(new Option("--no-pr", "Skip draft PR creation"))
    .option("--repo-path <path>", "Path to the target repository checkout")
    .option("--worktree-path <path>", "Path for the issue worktree")
    .option("--base <ref>", "Base ref for the worktree", "origin/main")
    .option("--branch <name>", "Branch name for the delivery run");
}

function normalizeDeliveryOptions(
  cliOptions: DeliveryCommandOptions & {
    commit?: boolean;
    push?: boolean;
    pr?: boolean;
  },
): DeliveryCommandOptions {
  return {
    ...cliOptions,
    noCommit: cliOptions.noCommit === true || cliOptions.commit === false,
    noPush: cliOptions.noPush === true || cliOptions.push === false,
    noPr: cliOptions.noPr === true || cliOptions.pr === false,
  };
}

export function createProgram(deps: ProgramDependencies = {}): Command {
  const program = new Command();
  program.name("meguribi").description("Meguribi local CLI").version("0.0.0");

  program
    .command("doctor")
    .description("Diagnose agent CLI readiness for Meguribi")
    .option("--json", "Emit AgentDiagnosis JSON only", false)
    .option("--non-interactive", "Fail closed on ambiguous MCP policy", false)
    .option("--implementer <kind>", "Implementer agent kind (devin or cursor)")
    .action(async (cliOptions: DoctorCommandOptions) => {
      try {
        const result = await runDoctor(cliOptions, deps);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        process.exitCode = 1;
      }
    });

  deliveryFlags(
    program
      .command("run")
      .description("Implement an approved Issue through verify/review/Draft PR")
      .argument("<target>", "Issue target, e.g. owner/repo#123"),
  ).action(async (target: string, cliOptions: DeliveryCommandOptions) => {
    try {
      const result = await runRunCommand(target, normalizeDeliveryOptions(cliOptions), deps);
      process.exitCode = result.exitCode;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
      process.exitCode = 1;
    }
  });

  deliveryFlags(
    program
      .command("resume")
      .description("Resume a delivery run after implementation_completed")
      .argument("<target>", "Issue target, e.g. owner/repo#123")
      .option("--run-id <id>", "Specific run ID to resume"),
  ).action(async (target: string, cliOptions: DeliveryCommandOptions) => {
    try {
      const result = await runResumeCommand(target, normalizeDeliveryOptions(cliOptions), deps);
      process.exitCode = result.exitCode;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
      process.exitCode = 1;
    }
  });

  return program;
}
