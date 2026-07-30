import type { GitAdapter, GitHubAdapter, PullRequestRecord, RunState, RunStore } from "./delivery.js";

export interface CleanupDependencies {
  github: Pick<GitHubAdapter, "getPullRequest">;
  git: Pick<GitAdapter, "getIdentity" | "getDiff" | "removeWorktree">;
  runStore: Pick<RunStore, "load" | "loadLatest" | "readArtifact" | "saveArtifact">;
}

export interface CleanupInput {
  repository: string;
  issueNumber: number;
  repositoryPath: string;
  runId?: string;
  dryRun?: boolean;
  deleteBranch?: boolean;
}

export interface CleanupArtifact {
  schemaVersion: 1;
  artifactType: "cleanup";
  status: "dry_run" | "completed";
  runId: string;
  repository: string;
  issueNumber: number;
  worktreePath: string;
  branch: string;
  pullRequestNumber: number;
  pullRequestState: PullRequestRecord["state"];
  merged: boolean;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
}

export interface CleanupResult extends CleanupArtifact {
  artifactPath: string;
}

const activeStatuses = new Set<RunState["status"]>([
  "created",
  "planning",
  "planned",
  "implementing",
  "verifying",
  "reviewing",
  "fixing",
  "publishing",
]);

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "cleanup_refused" });
}

async function loadRun(input: CleanupInput, runStore: CleanupDependencies["runStore"]): Promise<RunState> {
  const state = input.runId
    ? await runStore.load(input.runId)
    : await runStore.loadLatest(input.repository, input.issueNumber);
  if (!state) {
    fail(`No delivery Run found for ${input.repository}#${String(input.issueNumber)}; run plan/run first or provide --run-id`);
  }
  if (state.repository !== input.repository || state.issueNumber !== input.issueNumber) {
    fail(`Run ${state.runId} does not belong to ${input.repository}#${String(input.issueNumber)}; provide the matching target`);
  }
  return state;
}

function completedArtifact(value: unknown, state: RunState): CleanupArtifact | null {
  if (!value || typeof value !== "object") return null;
  const artifact = value as Partial<CleanupArtifact>;
  if (
    artifact.schemaVersion !== 1 ||
    artifact.artifactType !== "cleanup" ||
    artifact.status !== "completed" ||
    artifact.runId !== state.runId ||
    artifact.repository !== state.repository ||
    artifact.issueNumber !== state.issueNumber ||
    typeof artifact.worktreePath !== "string" ||
    typeof artifact.branch !== "string" ||
    typeof artifact.pullRequestNumber !== "number" ||
    (artifact.pullRequestState !== "open" && artifact.pullRequestState !== "closed") ||
    typeof artifact.merged !== "boolean" ||
    typeof artifact.worktreeRemoved !== "boolean" ||
    typeof artifact.branchRemoved !== "boolean"
  ) {
    return null;
  }
  return artifact as CleanupArtifact;
}

export async function cleanupRun(input: CleanupInput, deps: CleanupDependencies): Promise<CleanupResult> {
  const state = await loadRun(input, deps.runStore);
  const previous = completedArtifact(await deps.runStore.readArtifact(input.runId ?? state.runId, "cleanup.json"), state);
  if (previous && !input.dryRun) {
    return { ...previous, artifactPath: "cleanup.json" };
  }

  if (activeStatuses.has(state.status)) {
    fail(`Run ${state.runId} is still active (${state.status}); stop/resume it and retry cleanup after it reaches a terminal state`);
  }
  if (state.pullRequestNumber === null) {
    fail(`Run ${state.runId} has no Pull Request; cleanup refuses to delete an unreviewed worktree`);
  }

  const pullRequest = await deps.github.getPullRequest(input.repository, state.pullRequestNumber);
  if (pullRequest.number !== state.pullRequestNumber || pullRequest.head !== state.branch) {
    fail(`Pull Request identity does not match Run ${state.runId}; inspect the PR and saved Run state before retrying`);
  }
  if (pullRequest.state === "open") {
    fail(`Pull Request #${String(pullRequest.number)} is still open; merge or close it before cleanup`);
  }

  const identity = await deps.git.getIdentity(state.worktreePath);
  if (
    identity.branch !== state.branch ||
    identity.headSha !== state.headSha ||
    identity.remoteIdentity !== state.remoteIdentity ||
    identity.headSha !== pullRequest.headSha
  ) {
    fail(`Run identity mismatch for ${state.runId}; restore branch, HEAD, remote, and PR head before retrying cleanup`);
  }
  const diff = await deps.git.getDiff(state.worktreePath);
  if (diff.changedFiles.length > 0) {
    fail(`Worktree ${state.worktreePath} has unsaved changes; commit or preserve them before cleanup`);
  }
  if (input.deleteBranch && !pullRequest.merged) {
    fail(`Local branch deletion requires a merged Pull Request; #${String(pullRequest.number)} is only closed`);
  }

  const artifactBase: CleanupArtifact = {
    schemaVersion: 1,
    artifactType: "cleanup",
    status: input.dryRun ? "dry_run" : "completed",
    runId: state.runId,
    repository: state.repository,
    issueNumber: state.issueNumber,
    worktreePath: state.worktreePath,
    branch: state.branch,
    pullRequestNumber: pullRequest.number,
    pullRequestState: pullRequest.state,
    merged: pullRequest.merged,
    worktreeRemoved: false,
    branchRemoved: false,
  };

  if (!input.dryRun) {
    const removed = await deps.git.removeWorktree({
      repositoryPath: input.repositoryPath,
      worktreePath: state.worktreePath,
      branch: state.branch,
      deleteBranch: input.deleteBranch === true,
    });
    artifactBase.worktreeRemoved = removed.worktreeRemoved;
    artifactBase.branchRemoved = removed.branchRemoved;
  }

  const artifactPath = await deps.runStore.saveArtifact(state.runId, "cleanup.json", artifactBase);
  return { ...artifactBase, artifactPath };
}
