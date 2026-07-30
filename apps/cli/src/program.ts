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
import { runInit, type InitCommandDependencies, type InitCommandOptions } from "./commands/init.js";
import { runPlanCommand, type PlanCommandDependencies, type PlanCommandOptions } from "./commands/plan.js";
import { runReviewCommand, type ReviewCommandDependencies, type ReviewCommandOptions } from "./commands/review.js";
import { runCleanupCommand, type CleanupCommandDependencies, type CleanupCommandOptions } from "./commands/cleanup.js";
import { runDiscoverCommand, type DiscoverCommandDependencies, type DiscoverCommandOptions } from "./commands/discover.js";
import { runHypothesisCommand, type HypothesisCommandDependencies, type HypothesisCommandOptions } from "./commands/hypothesis.js";
import { runPromoteCommand, type PromoteCommandDependencies, type PromoteCommandOptions } from "./commands/promote.js";
import { runExploreCommand, type ExploreCommandDependencies, type ExploreCommandOptions } from "./commands/explore.js";
import { runRequireCommand, type RequireCommandDependencies, type RequireCommandOptions } from "./commands/require.js";
import { runMeasureCommand, type MeasureCommandDependencies, type MeasureCommandOptions } from "./commands/measure.js";

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

export interface ProgramDependencies
  extends DoctorDependencies, DeliveryCommandDependencies, InitCommandDependencies, PlanCommandDependencies, ReviewCommandDependencies, CleanupCommandDependencies, DiscoverCommandDependencies, HypothesisCommandDependencies, PromoteCommandDependencies, ExploreCommandDependencies, RequireCommandDependencies, MeasureCommandDependencies {
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
    // Output and diagnostic flags are CLI concerns, not implementer config.
    // Passing the whole Commander options object makes strict config schemas
    // reject valid invocations such as `doctor --json`.
    cli: options.implementer ? { implementer: options.implementer } : {},
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
    .option("--local", "Use a local Issue document and local Git repository; never call GitHub", false)
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
    .command("init")
    .description("Diagnose a repository and create a non-destructive Meguribi config template")
    .argument("[path]", "Path to the target Git repository", ".")
    .option("--json", "Emit initialization diagnostics JSON only", false)
    .option("--non-interactive", "Fail closed on ambiguous MCP policy", false)
    .option("--implementer <kind>", "Implementer agent kind (devin or cursor)")
    .action(async (targetPath: string | undefined, cliOptions: InitCommandOptions) => {
      try {
        const result = await runInit(targetPath, cliOptions, deps);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("discover")
    .description("Extract evidence-backed problem candidates without creating Issues")
    .argument("<target>", "Repository target, e.g. owner/repo")
    .option("--json", "Emit DiscoveryResult JSON only", false)
    .option("--local", "Use local Issue documents and local files; never call GitHub", false)
    .option("--repo-path <path>", "Path to the target repository checkout")
    .option("--input <path>", "Markdown or JSON observations to include")
    .option("--since <duration>", "Updated Issue window, e.g. 30d", "30d")
    .option("--label <name>", "Filter Issues by label")
    .option("--limit <number>", "Maximum number of Issues to inspect", (value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new Error(`Invalid --limit: ${value}`);
      return parsed;
    }, 5)
    .action(async (target: string, cliOptions: DiscoverCommandOptions) => {
      try {
        const result = await runDiscoverCommand(target, cliOptions, deps);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("plan")
    .description("Create a read-only Codex implementation plan for an Issue")
    .argument("<target>", "Issue target, e.g. owner/repo#123")
    .option("--json", "Emit PlanResult JSON only", false)
    .option("--local", "Use a local Issue document and local repository; never call GitHub", false)
    .option("--repo-path <path>", "Path to the target repository checkout")
    .option("--request <text>", "Additional user request to guide the plan")
    .action(async (target: string, cliOptions: PlanCommandOptions) => {
      try {
        const result = await runPlanCommand(target, cliOptions, deps);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("hypothesis")
    .description("Structure an Issue hypothesis without inventing missing evidence")
    .argument("<target>", "Issue target, e.g. owner/repo#123")
    .option("--json", "Emit HypothesisResult JSON only", false)
    .option("--local", "Use a local Issue document and local repository; never call GitHub", false)
    .option("--repo-path <path>", "Path to the target repository checkout")
    .action(async (target: string, cliOptions: HypothesisCommandOptions) => {
      try {
        const result = await runHypothesisCommand(target, cliOptions, deps);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("promote")
    .description("Create a human-reviewed Problem Issue draft from a validated Hypothesis")
    .argument("<target>", "Issue target, e.g. owner/repo#123")
    .option("--json", "Emit PromoteResult JSON only", false)
    .option("--local", "Use local Issue documents and local repository; never call GitHub", false)
    .option("--repo-path <path>", "Path to the target repository checkout")
    .option("--create-issue", "Create a Problem Issue after interactive human confirmation", false)
    .action(async (target: string, cliOptions: PromoteCommandOptions) => {
      try {
        const result = await runPromoteCommand(target, cliOptions, deps);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("explore")
    .description("Compare explicit solution directions without selecting a winner")
    .argument("<target>", "Problem Issue target, e.g. owner/repo#124")
    .option("--json", "Emit ExploreResult JSON only", false)
    .option("--local", "Use local Issue documents and local repository; never call GitHub", false)
    .option("--repo-path <path>", "Path to the target repository checkout")
    .action(async (target: string, cliOptions: ExploreCommandOptions) => {
      try {
        const result = await runExploreCommand(target, cliOptions, deps);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("require")
    .description("Create a human-reviewed Requirement draft from an explicitly selected solution")
    .argument("<target>", "Problem Issue target, e.g. owner/repo#124")
    .requiredOption("--solution <number>", "1-based solution number", (value) => {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid --solution: ${value}`);
      return number;
    })
    .option("--json", "Emit RequirementResult JSON only", false)
    .option("--local", "Use local Issue documents and local repository; never call GitHub", false)
    .option("--repo-path <path>", "Path to the target repository checkout")
    .action(async (target: string, cliOptions: RequireCommandOptions) => {
      try {
        const result = await runRequireCommand(target, cliOptions, deps);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("measure")
    .description("Create a human-reviewed post-release Measurement draft")
    .argument("<target>", "Requirement or Feature Issue target, e.g. owner/repo#125")
    .requiredOption("--period <duration>", "Measurement period, e.g. 14d or 2w")
    .option("--json", "Emit MeasurementResult JSON only", false)
    .option("--local", "Use local Issue documents and local repository; never call GitHub", false)
    .option("--repo-path <path>", "Path to the target repository checkout")
    .action(async (target: string, cliOptions: MeasureCommandOptions) => {
      try {
        const result = await runMeasureCommand(target, cliOptions, deps);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("review")
    .description("Re-run a read-only Codex review for an existing delivery Run")
    .argument("<target>", "Issue target, e.g. owner/repo#123")
    .option("--json", "Emit ReviewResult JSON only", false)
    .option("--local", "Use a local Issue document and local repository; never call GitHub", false)
    .option("--repo-path <path>", "Path to the target repository checkout")
    .option("--run-id <id>", "Specific delivery Run ID to review")
    .action(async (target: string, cliOptions: ReviewCommandOptions) => {
      try {
        const result = await runReviewCommand(target, cliOptions, deps);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("cleanup")
    .description("Remove a completed Run worktree after its Pull Request is closed or merged")
    .argument("<target>", "Issue target, e.g. owner/repo#123")
    .option("--json", "Emit CleanupResult JSON only", false)
    .option("--local", "Use a local Issue document and local repository; never call GitHub", false)
    .option("--repo-path <path>", "Path to the target repository checkout")
    .option("--run-id <id>", "Specific delivery Run ID to clean up")
    .option("--dry-run", "Check cleanup safety without removing anything", false)
    .option("--delete-branch", "Delete the local branch only when the Pull Request was merged", false)
    .action(async (target: string, cliOptions: CleanupCommandOptions) => {
      try {
        const result = await runCleanupCommand(target, cliOptions, deps);
        process.exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`${message}\n`);
        process.exitCode = 1;
      }
    });

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
