import {
  reviewIssue,
  type ReviewDependencies,
  type ReviewResult,
} from "@meguribi/core";
import { parseIssueTarget } from "../target.js";

export interface ReviewCommandOptions {
  json?: boolean;
  local?: boolean;
  repoPath?: string;
  runId?: string;
}

export interface ReviewCommandDependencies {
  review?: ReviewDependencies;
  reviewIssue?: typeof reviewIssue;
  createReviewDependencies?: (options: {
    cwd: string;
    repositoryPath: string;
    repository: string;
    localOnly: boolean;
  }) => Promise<ReviewDependencies>;
  cwd?: string;
  stdout?: (text: string) => void;
}

export async function runReviewCommand(
  target: string,
  options: ReviewCommandOptions = {},
  deps: ReviewCommandDependencies = {},
): Promise<{ exitCode: number; result?: ReviewResult }> {
  const parsed = parseIssueTarget(target);
  const cwd = deps.cwd ?? process.cwd();
  const repositoryPath = options.repoPath ?? cwd;
  const reviewDependencies = deps.review ?? await (
    deps.createReviewDependencies ?? (async (wiringOptions) => {
      const wiring = await import("../wiring/create-delivery-deps.js");
      return wiring.createReviewDependencies(wiringOptions);
    })
  )({
    cwd,
    repositoryPath,
    repository: parsed.repository,
    localOnly: options.local === true,
  });
  const result = await (deps.reviewIssue ?? reviewIssue)(
    {
      repository: parsed.repository,
      issueNumber: parsed.issueNumber,
      repositoryPath,
      repositoryRules: "Follow AGENTS.md",
      runId: options.runId,
    },
    reviewDependencies,
  );
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  writeOut(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(result));
  return { exitCode: 0, result };
}

function formatHuman(result: ReviewResult): string {
  return [
    `Review: ${result.review.status}`,
    `Run: ${result.runId}`,
    `Branch: ${result.branch}`,
    `Artifact: ${result.artifactPath}`,
    `Issue comment: #${String(result.commentId)}`,
    "",
    result.review.summary,
    "",
  ].join("\n");
}
