import { Command } from "commander";
import { diagnoseDevin, formatDevinDiagnosisHuman } from "@meguribi/adapters";
import { loadDevinConfig } from "@meguribi/config";
import { DevinDiagnosisSchema } from "@meguribi/schemas";
import * as v from "valibot";
import type { DevinDiagnosis } from "@meguribi/schemas";

export interface DoctorCommandOptions {
  json?: boolean;
  nonInteractive?: boolean;
}

export interface DoctorDependencies {
  diagnose?: typeof diagnoseDevin;
  loadConfig?: typeof loadDevinConfig;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function runDoctor(
  options: DoctorCommandOptions,
  deps: DoctorDependencies = {},
): Promise<{ exitCode: number; diagnosis: DevinDiagnosis }> {
  const loadConfig = deps.loadConfig ?? loadDevinConfig;
  const diagnose = deps.diagnose ?? diagnoseDevin;
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const cwd = deps.cwd ?? process.cwd();

  const config = await loadConfig({
    repositoryPath: cwd,
    // 曖昧な MCP ポリシーは diagnoseDevin 側で構造化して返す。
    // config loader の nonInteractive throw には乗せない。
    nonInteractive: false,
  });

  const diagnosis = await diagnose({
    executable: config.config.executable,
    inheritedMcpPolicy: config.config.inheritedMcpPolicy,
    nonInteractive: options.nonInteractive ?? false,
    cwd,
    probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
  });

  const validated = v.parse(DevinDiagnosisSchema, diagnosis);

  if (options.json) {
    writeOut(`${JSON.stringify(validated, null, 2)}\n`);
  } else {
    writeOut(formatDevinDiagnosisHuman(validated));
  }

  return {
    exitCode: validated.runnable ? 0 : 1,
    diagnosis: validated,
  };
}

export function createProgram(deps: DoctorDependencies = {}): Command {
  const program = new Command();
  program.name("meguribi").description("Meguribi local CLI").version("0.0.0");

  program
    .command("doctor")
    .description("Diagnose Devin CLI readiness for Meguribi")
    .option("--json", "Emit DevinDiagnosis JSON only", false)
    .option("--non-interactive", "Fail closed on ambiguous MCP policy", false)
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

  return program;
}
