import type { PullRequestRecord, RunState } from "./index.js";
import { cleanupRun } from "./cleanup.js";
import { describe, expect, it } from "vitest";

const state: RunState = {
  schemaVersion: 1,
  runId: "20260730T000000Z-cleanup1",
  repository: "owner/repo",
  issueNumber: 22,
  command: "run",
  status: "awaiting_human",
  completedSteps: ["implementation_completed", "verifying", "reviewing", "publishing", "awaiting_human"],
  branch: "meguribi/issue-22",
  worktreePath: "C:/worktrees/issue-22",
  baseRef: "origin/main",
  baseSha: "base-sha",
  headSha: "head-sha",
  remoteIdentity: "github.com/owner/repo",
  pullRequestNumber: 101,
  agentSessions: { devinImplementation: "session-22" },
  fixAttempts: 0,
  maxFixAttempts: 2,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

const pullRequest: PullRequestRecord = {
  number: 101,
  url: "https://github.com/owner/repo/pull/101",
  state: "closed",
  merged: true,
  head: state.branch,
  headSha: state.headSha,
};

function dependencies(options: { diff?: string[]; pullRequest?: Partial<PullRequestRecord> } = {}) {
  let cleanupArtifact: unknown;
  let removed = 0;
  return {
    get removed() {
      return removed;
    },
    deps: {
      github: {
        getPullRequest: async () => ({ ...pullRequest, ...options.pullRequest }),
      },
      git: {
        getIdentity: async () => ({ branch: state.branch, headSha: state.headSha, remoteIdentity: state.remoteIdentity }),
        getDiff: async () => ({ changedFiles: options.diff ?? [], patch: "" }),
        removeWorktree: async () => {
          removed += 1;
          return { worktreeRemoved: true, branchRemoved: true };
        },
      },
      runStore: {
        load: async () => state,
        loadLatest: async () => state,
        readArtifact: async <T>() => cleanupArtifact as T | null,
        saveArtifact: async (_runId: string, _name: string, value: unknown) => {
          cleanupArtifact = value;
          return "C:/runs/cleanup.json";
        },
      },
    },
  };
}

describe("cleanupRun", () => {
  it("removes a clean worktree only after the PR is closed and is idempotent", async () => {
    const bundle = dependencies();
    const result = await cleanupRun(
      { repository: state.repository, issueNumber: state.issueNumber, repositoryPath: "C:/repo", deleteBranch: true },
      bundle.deps,
    );

    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchRemoved).toBe(true);
    expect(bundle.removed).toBe(1);
    await expect(
      cleanupRun(
        { repository: state.repository, issueNumber: state.issueNumber, repositoryPath: "C:/repo" },
        bundle.deps,
      ),
    ).resolves.toMatchObject({ status: "completed", worktreeRemoved: true });
    expect(bundle.removed).toBe(1);
  });

  it("refuses uncommitted changes and an open PR", async () => {
    await expect(
      cleanupRun(
        { repository: state.repository, issueNumber: state.issueNumber, repositoryPath: "C:/repo" },
        dependencies({ diff: ["src/changed.ts"] }).deps,
      ),
    ).rejects.toThrow("unsaved changes");
    await expect(
      cleanupRun(
        { repository: state.repository, issueNumber: state.issueNumber, repositoryPath: "C:/repo" },
        dependencies({ pullRequest: { state: "open" } }).deps,
      ),
    ).rejects.toThrow("still open");
  });
});
