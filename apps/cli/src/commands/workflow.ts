import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadRepositoryWorkflows, parseWorkflowDefinition } from "@meguribi/config";
import {
  createDeliveryWorkflow,
  createDiscussionWorkflow,
  validateWorkflowDefinition,
} from "@meguribi/core";

export interface WorkflowValidateCommandDependencies {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  readFile?: (path: string) => Promise<string>;
}

export interface WorkflowListCommandOptions {
  repoPath?: string;
}

export interface WorkflowListCommandDependencies {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  cwd?: string;
  loadWorkflows?: typeof loadRepositoryWorkflows;
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

function displayWorkflowPath(filePath: string, repositoryPath: string): string {
  const relative = path.relative(repositoryPath, filePath);
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return filePath;
}

function formatWorkflowLine(name: string, source: string, steps: readonly { id: string }[]): string {
  return `${name} (${source}, ${String(steps.length)} steps): ${steps.map((step) => step.id).join(", ")}\n`;
}

export async function runWorkflowListCommand(
  options: WorkflowListCommandOptions = {},
  deps: WorkflowListCommandDependencies = {},
): Promise<{ exitCode: number }> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const repositoryPath = path.resolve(options.repoPath ?? deps.cwd ?? process.cwd());
  const loadWorkflows = deps.loadWorkflows ?? loadRepositoryWorkflows;
  const delivery = createDeliveryWorkflow(2);
  const discussion = createDiscussionWorkflow();
  const lines = [
    formatWorkflowLine(delivery.name, "built-in", delivery.steps),
    formatWorkflowLine(discussion.name, "built-in", discussion.steps),
  ];

  for (const workflow of await loadWorkflows(repositoryPath)) {
    const shownPath = displayWorkflowPath(workflow.path, repositoryPath);
    if (workflow.definition) {
      lines.push(formatWorkflowLine(workflow.definition.name, shownPath, workflow.definition.steps));
    } else {
      lines.push(`${shownPath}: error: ${workflow.error ?? "unknown error"}\n`);
    }
  }

  stdout(lines.join(""));
  return { exitCode: 0 };
}
