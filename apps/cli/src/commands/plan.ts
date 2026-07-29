import {
  planIssue,
  type PlanDependencies,
  type PlanResult,
} from "@meguribi/core";
import { parseIssueTarget } from "../target.js";

export interface PlanCommandOptions {
  json?: boolean;
  local?: boolean;
  repoPath?: string;
}

export interface PlanCommandDependencies {
  plan?: PlanDependencies;
  createPlanDependencies?: (options: {
    cwd: string;
    repositoryPath: string;
    repository: string;
    localOnly: boolean;
  }) => Promise<PlanDependencies>;
  cwd?: string;
  stdout?: (text: string) => void;
}

export async function runPlanCommand(
  target: string,
  options: PlanCommandOptions = {},
  deps: PlanCommandDependencies = {},
): Promise<{ exitCode: number; result?: PlanResult }> {
  const parsed = parseIssueTarget(target);
  const cwd = deps.cwd ?? process.cwd();
  const repositoryPath = options.repoPath ?? cwd;
  const planDependencies = deps.plan ?? await (
    deps.createPlanDependencies ?? (async (wiringOptions) => {
      const wiring = await import("../wiring/create-delivery-deps.js");
      return wiring.createPlanDependencies(wiringOptions);
    })
  )({
    cwd,
    repositoryPath,
    repository: parsed.repository,
    localOnly: options.local === true,
  });
  const result = await planIssue(
    {
      repository: parsed.repository,
      issueNumber: parsed.issueNumber,
      repositoryPath,
      repositoryRules: "Follow AGENTS.md",
      completionCriteria: ["Verification commands pass", "Codex review does not require changes"],
      outOfScope: [],
    },
    planDependencies,
  );
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  writeOut(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(result));
  return { exitCode: 0, result };
}

function formatHuman(result: PlanResult): string {
  return [
    `Plan: ${result.plan.summary}`,
    `Artifact: ${result.artifactPath}`,
    `Issue comment: #${String(result.commentId)}`,
    "",
    "Steps:",
    ...result.plan.steps.map((step) => `- ${step}`),
    "",
  ].join("\n");
}
