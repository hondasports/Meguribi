import type { IssueRecord, PlanArtifact, ReviewArtifact, RunState } from "./index.js";
import { describe, expect, it } from "vitest";
import { CODE_REVIEW_MARKER, reviewIssue } from "./review.js";

const issue: IssueRecord = {
  number: 8,
  title: "Review the implementation",
  body: "Review the latest Run.",
  labels: [],
  comments: [],
  updatedAt: "2026-07-30T00:00:00.000Z",
};

const state: RunState = {
  schemaVersion: 1,
  runId: "20260730T000000Z-review1",
  repository: "owner/repo",
  issueNumber: 8,
  command: "run",
  status: "blocked",
  currentStep: "implementation_blocked",
  completedSteps: ["implementation_completed", "verifying", "reviewing"],
  branch: "meguribi/issue-8",
  worktreePath: "C:/worktrees/issue-8",
  baseRef: "origin/main",
  baseSha: "base",
  headSha: "head",
  remoteIdentity: "github.com/owner/repo",
  pullRequestNumber: 108,
  agentSessions: { codexPlan: "plan-thread" },
  fixAttempts: 0,
  maxFixAttempts: 2,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
  lastError: {
    code: "policy_blocked",
    message: "review still requires changes after fix attempts",
  },
};

const plan: PlanArtifact = {
  schemaVersion: 1,
  artifactType: "implementation-plan",
  summary: "Review implementation",
  requirements: ["Review the diff"],
  acceptanceCriteria: ["A structured review is saved"],
  outOfScope: [],
  proposedFiles: ["src/feature.ts"],
  steps: ["Review"],
  risks: [],
  tests: ["Review unit test"],
  humanDecisions: [],
  unresolvedItems: [],
  metadata: {
    schemaVersion: 1,
    artifactId: "plan-8",
    createdAt: "2026-07-30T00:00:00.000Z",
    durationMs: 1,
    producer: { kind: "codex", role: "planner", threadId: "plan-thread" },
    sourceDigests: {},
    eventLog: [],
  },
};

const review: ReviewArtifact = {
  schemaVersion: 1,
  artifactType: "code-review",
  status: "approved_with_notes",
  summary: "The implementation is ready with a note.",
  requirementCoverage: [],
  findings: [],
  missingTests: ["Add an integration test later"],
  scopeViolations: [],
  recommendedAction: "proceed",
  metadata: {
    schemaVersion: 1,
    artifactId: "review-8",
    createdAt: "2026-07-30T00:00:00.000Z",
    durationMs: 2,
    producer: { kind: "codex", role: "reviewer", threadId: "review-thread" },
    sourceDigests: {},
    eventLog: [],
  },
};

function dependencies(overrides: { identity?: Partial<typeof state>; review?: ReviewArtifact } = {}) {
  const saved: Record<string, unknown> = {};
  let updated: RunState | undefined;
  let requestedBaseSha: string | undefined;
  const identity = {
    branch: overrides.identity?.branch ?? state.branch,
    headSha: overrides.identity?.headSha ?? state.headSha,
    remoteIdentity: overrides.identity?.remoteIdentity ?? state.remoteIdentity,
  };
  return {
    saved,
    get updated() {
      return updated;
    },
    get requestedBaseSha() {
      return requestedBaseSha;
    },
    deps: {
      github: {
        getIssue: async () => issue,
        upsertMarkerComment: async (input: { marker: string; body: string }) => {
          saved.comment = input;
          return { commentId: 18 };
        },
      },
      git: {
        getIdentity: async () => identity,
        getDiff: async (_worktreePath: string, baseSha?: string) => {
          requestedBaseSha = baseSha;
          return { changedFiles: ["src/feature.ts"], patch: "diff --git a/src/feature.ts b/src/feature.ts" };
        },
      },
      codex: { review: async () => overrides.review ?? review },
      runStore: {
        load: async () => state,
        loadLatest: async () => state,
        update: async (_runId: string, patch: Partial<RunState>) => {
          updated = { ...state, ...patch };
          return updated;
        },
        saveArtifact: async (_runId: string, name: string, value: unknown) => {
          saved[name] = value;
          return `C:/runs/${name}`;
        },
        readArtifact: async <T>(_runId: string, name: string) => {
          if (name === "plan.json") return plan as T;
          if (name === "implementation-result.json") return { status: "completed", changedFiles: ["src/feature.ts"] } as T;
          if (name === "verification.json") return { schemaVersion: 1, artifactType: "verification", success: true, commands: [] } as T;
          return null;
        },
      },
    },
  };
}

describe("reviewIssue", () => {
  it("re-runs Codex review from the latest Run evidence and updates the marker", async () => {
    const bundle = dependencies();
    const result = await reviewIssue(
      {
        repository: "owner/repo",
        issueNumber: 8,
        repositoryPath: "C:/repo",
        repositoryRules: "Follow AGENTS.md",
      },
      bundle.deps,
    );

    expect(result.runId).toBe(state.runId);
    expect(result.artifactPath).toBe("C:/runs/review.json");
    expect(bundle.saved["review.json"]).toEqual(review);
    expect((bundle.saved.comment as { marker: string }).marker).toBe(CODE_REVIEW_MARKER);
    expect(bundle.updated?.agentSessions.codexReview).toBe("review-thread");
    expect(bundle.updated?.status).toBe("awaiting_human");
    expect(bundle.updated?.currentStep).toBe("awaiting_human");
    expect(bundle.updated?.lastError).toBeUndefined();
    expect(bundle.requestedBaseSha).toBe(state.baseSha);
  });

  it("stops before Codex when the saved worktree identity changed", async () => {
    const bundle = dependencies({ identity: { headSha: "different-head" } });
    await expect(
      reviewIssue(
        {
          repository: "owner/repo",
          issueNumber: 8,
          repositoryPath: "C:/repo",
          repositoryRules: "Follow AGENTS.md",
        },
        bundle.deps,
      ),
    ).rejects.toThrow("Review identity mismatch");
    expect(bundle.saved["review.json"]).toBeUndefined();
  });
});
