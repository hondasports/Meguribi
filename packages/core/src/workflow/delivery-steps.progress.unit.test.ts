import { describe, expect, it } from "vitest";
import type {
  DeliveryDependencies,
  ImplementationResult,
  IssueRecord,
  PlanArtifact,
  ReviewArtifact,
  RunDeliveryInput,
  RunState,
  RunStore,
  VerificationResult,
  WorkflowEvent,
} from "../index.js";
import { runDelivery } from "./delivery.js";

function iso(): string {
  return "2026-11-28T12:00:00.000Z";
}

function createRunState(input: Parameters<RunStore["create"]>[0]): RunState {
  return {
    schemaVersion: 1,
    runId: "run-progress",
    repository: input.repository,
    issueNumber: input.issueNumber,
    command: input.command,
    status: "created",
    completedSteps: [],
    branch: input.identity.branch,
    worktreePath: input.identity.worktreePath,
    baseRef: input.identity.baseRef,
    baseSha: input.identity.baseSha,
    headSha: input.identity.headSha,
    remoteIdentity: input.identity.remoteIdentity,
    pullRequestNumber: null,
    agentSessions: {},
    fixAttempts: 0,
    maxFixAttempts: input.maxFixAttempts,
    createdAt: iso(),
    updatedAt: iso(),
  };
}

function createMemoryRunStore(): RunStore {
  let state: RunState | undefined;
  const artifacts = new Map<string, unknown>();
  return {
    create: async (input) => {
      state = createRunState(input);
      return structuredClone(state);
    },
    load: async (runId) => (state?.runId === runId ? structuredClone(state) : null),
    loadLatest: async () => (state ? structuredClone(state) : null),
    update: async (runId, patch) => {
      if (state?.runId !== runId) throw new Error(`Run not found: ${runId}`);
      state = { ...state, ...patch, runId, updatedAt: patch.updatedAt ?? iso() };
      return structuredClone(state);
    },
    saveArtifact: async (runId, name, value) => {
      artifacts.set(`${runId}/${name}`, value);
      return `memory://${runId}/${name}`;
    },
    readArtifact: async <T>(runId: string, name: string): Promise<T | null> => {
      const value = artifacts.get(`${runId}/${name}`);
      return value === undefined ? null : (structuredClone(value) as T);
    },
    acquireLock: async () => undefined,
    releaseLock: async () => undefined,
  };
}

function planArtifact(): PlanArtifact {
  return {
    schemaVersion: 1,
    artifactType: "implementation-plan",
    summary: "Implement the issue",
    requirements: ["requirement"],
    acceptanceCriteria: ["tests pass"],
    outOfScope: [],
    proposedFiles: ["src/example.ts"],
    steps: ["implement"],
    risks: [],
    tests: ["unit"],
    humanDecisions: [],
    unresolvedItems: [],
    metadata: {
      schemaVersion: 1,
      artifactId: "plan-1",
      createdAt: iso(),
      durationMs: 1,
      producer: { kind: "codex", role: "planner", threadId: "plan-thread" },
      sourceDigests: {},
      eventLog: [],
    },
  };
}

function reviewArtifact(status: ReviewArtifact["status"]): ReviewArtifact {
  return {
    schemaVersion: 1,
    artifactType: "code-review",
    status,
    summary: "review",
    requirementCoverage: [],
    findings: [],
    missingTests: [],
    scopeViolations: [],
    recommendedAction: "proceed",
    metadata: {
      schemaVersion: 1,
      artifactId: "review-1",
      createdAt: iso(),
      durationMs: 1,
      producer: { kind: "codex", role: "reviewer", threadId: "review-thread" },
      sourceDigests: {},
      eventLog: [],
    },
  };
}

function implementationResult(sessionId: string): ImplementationResult {
  return {
    status: "completed",
    sessionId,
    startedAt: iso(),
    finishedAt: iso(),
    durationMs: 1,
    stopReason: "end_turn",
    changedFiles: ["src/example.ts"],
    reportedFiles: ["src/example.ts"],
    unresolvedItems: [],
    permissionDecisions: [],
    artifactPaths: { root: "/artifacts" },
    promptVersion: "1",
    promptHash: "hash",
    publishable: true,
  };
}

function issueRecord(): IssueRecord {
  return {
    number: 22,
    title: "Add progress events",
    body: "Implement progress reporting.",
    labels: ["agent:ready"],
    comments: [],
    updatedAt: iso(),
  };
}

function baseInput(): RunDeliveryInput {
  return {
    repository: "owner/repo",
    issueNumber: 22,
    repositoryPath: "/repo",
    worktreePath: "/worktree",
    branch: "meguribi/issue-22",
    baseRef: "origin/main",
    repositoryRules: "Follow AGENTS.md",
    completionCriteria: ["tests pass"],
    outOfScope: [],
    requiredLabels: ["agent:ready"],
    protectedPaths: [],
    verifyCommands: [
      { name: "lint", run: "pnpm lint" },
      { name: "test", run: "pnpm test" },
    ],
    inheritedMcpPolicy: "allow",
    allowInheritedMcp: false,
    nonInteractive: false,
    maxFixAttempts: 2,
    artifactRootForDevin: "/artifacts",
  };
}

function createDeps(events: WorkflowEvent[]): DeliveryDependencies {
  let verifyCalls = 0;
  const implementer = {
    implement: async () => implementationResult("implement-session"),
    fix: async () => implementationResult("fix-session"),
  };
  return {
    github: {
      getIssue: async () => issueRecord(),
      listIssues: async () => [],
      getPullRequest: async () => {
        throw new Error("not used");
      },
      upsertMarkerComment: async () => ({ commentId: 1 }),
      createIssue: async () => ({ number: 22, url: "https://example.test/issues/22" }),
      createDraftPullRequest: async () => ({ number: 101, url: "https://example.test/pr/101" }),
      findDraftPullRequest: async () => null,
    },
    git: {
      ensureWorktree: async () => ({
        baseSha: "base-sha",
        headSha: "head-sha",
        remoteIdentity: "github.com/owner/repo",
      }),
      getIdentity: async () => ({
        branch: "meguribi/issue-22",
        headSha: "head-sha",
        remoteIdentity: "github.com/owner/repo",
      }),
      getDiff: async () => ({ changedFiles: ["src/example.ts"], patch: "diff" }),
      commit: async () => ({ headSha: "committed-sha" }),
      push: async () => undefined,
      removeWorktree: async () => ({ worktreeRemoved: true, branchRemoved: false }),
    },
    codex: {
      createPlan: async () => planArtifact(),
      review: async () => reviewArtifact("approved"),
    },
    implementer,
    devin: implementer,
    verifier: {
      verify: async (input) => {
        verifyCalls += 1;
        const success = verifyCalls > 1;
        const commands: VerificationResult["commands"] = [];
        for (const [index, command] of input.commands.entries()) {
          const logPath = input.logWriter
            ? await input.logWriter.write({
                commandName: command.name,
                commandIndex: index,
                stdout: success ? "ok" : "failed",
                stderr: "",
                truncated: false,
              })
            : undefined;
          commands.push({
            name: command.name,
            exitCode: success ? 0 : 1,
            startedAt: iso(),
            finishedAt: iso(),
            ...(logPath ? { logPath } : {}),
          });
        }
        return {
          schemaVersion: 1,
          artifactType: "verification",
          success,
          commands,
        } satisfies VerificationResult;
      },
    },
    policy: {
      assertReady: async () => undefined,
      evaluatePublish: async () => ({ allowed: true, reasons: [] }),
    },
    runStore: createMemoryRunStore(),
    onWorkflowEvent: (event) => events.push(event),
    now: () => new Date("2026-11-28T12:00:00.000Z"),
  };
}

describe("delivery step progress events", () => {
  it("emits verify command progress and fix attempt progress through onWorkflowEvent", async () => {
    const events: WorkflowEvent[] = [];

    const result = await runDelivery(baseInput(), createDeps(events));

    expect(result.published).toBe(true);
    const progress = events.filter((event) => event.type === "step.progress");
    expect(progress).toEqual([
      expect.objectContaining({
        type: "step.progress",
        runId: "run-progress",
        stepId: "verify",
        label: "verify",
        current: 1,
        max: 2,
      }),
      expect.objectContaining({
        type: "step.progress",
        runId: "run-progress",
        stepId: "verify",
        label: "verify",
        current: 2,
        max: 2,
      }),
      expect.objectContaining({
        type: "step.progress",
        runId: "run-progress",
        stepId: "fix-after-verify",
        label: "fix",
        current: 1,
        max: 2,
      }),
    ]);
  });
});
