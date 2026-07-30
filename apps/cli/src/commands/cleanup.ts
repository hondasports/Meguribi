import {
  cleanupRun,
  type CleanupDependencies,
  type CleanupResult,
} from "@meguribi/core";
import { parseIssueTarget } from "../target.js";

export interface CleanupCommandOptions {
  json?: boolean;
  local?: boolean;
  repoPath?: string;
  runId?: string;
  dryRun?: boolean;
  deleteBranch?: boolean;
}

export interface CleanupCommandDependencies {
  cleanup?: CleanupDependencies;
  cleanupRun?: typeof cleanupRun;
  createCleanupDependencies?: (options: {
    cwd: string;
    repositoryPath: string;
    repository: string;
    localOnly: boolean;
  }) => Promise<CleanupDependencies>;
  cwd?: string;
  stdout?: (text: string) => void;
}

export async function runCleanupCommand(
  target: string,
  options: CleanupCommandOptions = {},
  deps: CleanupCommandDependencies = {},
): Promise<{ exitCode: number; result?: CleanupResult }> {
  const parsed = parseIssueTarget(target);
  const cwd = deps.cwd ?? process.cwd();
  const repositoryPath = options.repoPath ?? cwd;
  const cleanupDependencies = deps.cleanup ?? await (
    deps.createCleanupDependencies ?? (async (wiringOptions) => {
      const wiring = await import("../wiring/create-delivery-deps.js");
      return wiring.createCleanupDependencies(wiringOptions);
    })
  )({
    cwd,
    repositoryPath,
    repository: parsed.repository,
    localOnly: options.local === true,
  });
  const result = await (deps.cleanupRun ?? cleanupRun)(
    {
      repository: parsed.repository,
      issueNumber: parsed.issueNumber,
      repositoryPath,
      runId: options.runId,
      dryRun: options.dryRun === true,
      deleteBranch: options.deleteBranch === true,
    },
    cleanupDependencies,
  );
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  writeOut(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(result));
  return { exitCode: 0, result };
}

function formatHuman(result: CleanupResult): string {
  const actions = result.status === "dry_run"
    ? "Dry run: worktree and optional branch deletion passed safety checks."
    : `Worktree removed: ${result.worktreeRemoved ? "yes" : "no"}\nBranch removed: ${result.branchRemoved ? "yes" : "no"}`;
  return [
    `Cleanup: ${result.status}`,
    `Run: ${result.runId}`,
    `Pull Request: #${String(result.pullRequestNumber)} (${result.merged ? "merged" : "closed"})`,
    actions,
    `Artifact: ${result.artifactPath}`,
    "",
  ].join("\n");
}
