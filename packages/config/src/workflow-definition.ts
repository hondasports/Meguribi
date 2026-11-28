import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";
import { STEP_KINDS, type WorkflowDefinition } from "@meguribi/core";

export class WorkflowDefinitionParseError extends Error {
  readonly path: string;
  readonly issues: readonly string[];

  constructor(sourcePath: string, issues: readonly string[], detail?: string) {
    super(`Invalid workflow definition ${sourcePath}: ${detail ?? issues.join(", ")}`);
    this.name = "WorkflowDefinitionParseError";
    this.path = issues[0] ?? "$";
    this.issues = issues;
  }
}

const transitionSchema = v.strictObject({
  goto: v.pipe(v.string(), v.nonEmpty()),
  max: v.number(),
});

const stepSchema = v.strictObject({
  id: v.pipe(v.string(), v.nonEmpty()),
  kind: v.picklist([...STEP_KINDS]),
  // oxlint-disable-next-line unicorn/no-thenable -- ワークフロー定義の `then` はデータフィールドであり thenable ではない
  then: v.optional(v.pipe(v.string(), v.nonEmpty())),
  of: v.optional(v.pipe(v.string(), v.nonEmpty())),
  onFailure: v.optional(transitionSchema),
  onChangesRequired: v.optional(transitionSchema),
});

const workflowDefinitionSchema = v.strictObject({
  name: v.pipe(v.string(), v.nonEmpty()),
  steps: v.array(stepSchema),
});

function formatIssuePath(issue: v.BaseIssue<unknown>): string {
  if (issue.path === undefined || issue.path.length === 0) {
    return "$";
  }
  return issue.path.map((item) => String(item.key)).join(".");
}

export function parseWorkflowDefinition(yamlText: string, sourcePath: string): WorkflowDefinition {
  let document: unknown;
  try {
    document = parseYaml(yamlText);
  } catch (error) {
    throw new WorkflowDefinitionParseError(
      sourcePath,
      ["<yaml>"],
      error instanceof Error ? error.message : String(error),
    );
  }

  const result = v.safeParse(workflowDefinitionSchema, document);
  if (!result.success) {
    const issues = result.issues.map(formatIssuePath);
    throw new WorkflowDefinitionParseError(sourcePath, issues);
  }
  return result.output;
}

export async function loadRepositoryWorkflows(
  repositoryPath: string,
): Promise<{ path: string; definition?: WorkflowDefinition; error?: string }[]> {
  const directory = path.join(repositoryPath, ".meguribi", "workflows");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const names = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")))
    .map((entry) => entry.name)
    .sort();
  const workflows: { path: string; definition?: WorkflowDefinition; error?: string }[] = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    try {
      const contents = await readFile(filePath, "utf8");
      workflows.push({ path: filePath, definition: parseWorkflowDefinition(contents, filePath) });
    } catch (error) {
      workflows.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return workflows;
}
