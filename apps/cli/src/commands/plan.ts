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
  request?: string;
  userRequest?: string;
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
  const userRequest = normalizeUserRequest(options.userRequest ?? options.request);
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
      userRequest,
      completionCriteria: ["Verification commands pass", "Codex review does not require changes"],
      outOfScope: [],
    },
    planDependencies,
  );
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  writeOut(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(result));
  return { exitCode: 0, result };
}

const MAX_USER_REQUEST_LENGTH = 12_000;

function normalizeUserRequest(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error("--request must not be empty");
  if (normalized.length > MAX_USER_REQUEST_LENGTH) {
    throw new Error(`--request must be ${String(MAX_USER_REQUEST_LENGTH)} characters or fewer`);
  }
  return normalized;
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
