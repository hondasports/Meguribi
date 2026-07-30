import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  promoteHypothesis,
  type PromoteDependencies,
  type PromoteResult,
} from "@meguribi/core";
import { parseIssueTarget } from "../target.js";

export interface PromoteCommandOptions {
  json?: boolean;
  local?: boolean;
  repoPath?: string;
  createIssue?: boolean;
}

export interface PromoteCommandDependencies {
  promote?: PromoteDependencies;
  promoteHypothesis?: typeof promoteHypothesis;
  createPromoteDependencies?: (options: {
    cwd: string;
    repositoryPath: string;
    repository: string;
    localOnly: boolean;
  }) => Promise<PromoteDependencies>;
  confirmCreateIssue?: () => Promise<boolean>;
  cwd?: string;
  stdout?: (text: string) => void;
}

export async function runPromoteCommand(
  target: string,
  options: PromoteCommandOptions = {},
  deps: PromoteCommandDependencies = {},
): Promise<{ exitCode: number; result?: PromoteResult }> {
  const parsed = parseIssueTarget(target);
  const cwd = deps.cwd ?? process.cwd();
  const repositoryPath = options.repoPath ?? cwd;
  const promoteDependencies = deps.promote ?? await (
    deps.createPromoteDependencies ?? (async (wiringOptions) => {
      const wiring = await import("../wiring/create-delivery-deps.js");
      return wiring.createPromoteDependencies(wiringOptions);
    })
  )({ cwd, repositoryPath, repository: parsed.repository, localOnly: options.local === true });
  const confirmCreateIssue = options.createIssue === true
    ? (deps.confirmCreateIssue ?? confirmInTerminal)
    : undefined;
  const result = await (deps.promoteHypothesis ?? promoteHypothesis)({
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
    createIssue: options.createIssue === true,
    confirmCreateIssue,
  }, promoteDependencies);
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  writeOut(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(result));
  return { exitCode: 0, result };
}

async function confirmInTerminal(): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) throw new Error("--create-issue requires an interactive human confirmation");
  const reader = createInterface({ input, output });
  try {
    const answer = await reader.question("Create the Problem Issue from this draft? [y/N] ");
    return /^y(?:es)?$/iu.test(answer.trim());
  } finally {
    reader.close();
  }
}

function formatHuman(result: PromoteResult): string {
  return [
    `Problem draft: ${result.artifact.title}`,
    `Evidence: ${String(result.artifact.evidence.length)}`,
    `Unconfirmed: ${result.artifact.unconfirmedItems.length > 0 ? result.artifact.unconfirmedItems.join(", ") : "none"}`,
    `Artifact: ${result.artifactPath}`,
    `Issue comment: #${String(result.commentId)}`,
    result.createdIssue ? `Created Issue: #${String(result.createdIssue.number)} (${result.createdIssue.url})` : "Created Issue: no",
    "Human approval required: yes",
    "",
  ].join("\n");
}
