import { readFile } from "node:fs/promises";
import { parseWorkflowDefinition } from "@meguribi/config";
import { validateWorkflowDefinition } from "@meguribi/core";

export interface WorkflowValidateCommandDependencies {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  readFile?: (path: string) => Promise<string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runWorkflowValidateCommand(
  file: string,
  deps: WorkflowValidateCommandDependencies = {},
): Promise<{ exitCode: number }> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const read = deps.readFile ?? ((pathname: string) => readFile(pathname, "utf8"));

  let definition;
  try {
    definition = parseWorkflowDefinition(await read(file), file);
  } catch (error) {
    stderr(`${errorMessage(error)}\n`);
    return { exitCode: 1 };
  }

  const issues = validateWorkflowDefinition(definition);
  if (issues.length > 0) {
    for (const issue of issues) {
      stderr(`${issue.code} ${issue.stepId ?? "-"}: ${issue.message}\n`);
    }
    return { exitCode: 1 };
  }

  stdout(`OK: ${definition.name} (${String(definition.steps.length)} steps)\n`);
  return { exitCode: 0 };
}
