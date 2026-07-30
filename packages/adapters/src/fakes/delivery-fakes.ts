import os from "node:os";
import path from "node:path";
import type {
  DeliveryDependencies,
  DeliveryMcpConfirmation,
  DevinAdapter,
  FixInput,
  GitAdapter,
  GitHubAdapter,
  ImplementationInput,
  ImplementationResult,
  IssueRecord,
  PlanArtifact,
  PolicyEngine,
  PullRequestRecord,
  PublishDecision,
  ReviewArtifact,
  RunState,
  RunStore,
  VerificationResult,
  Verifier,
} from "@meguribi/core";

export interface CallCounter {
  counts: Record<string, number>;
  track(name: string): void;
}

function createCounter(): CallCounter {
  const counts: Record<string, number> = {};
  return {
    counts,
    track(name: string) {
      counts[name] = (counts[name] ?? 0) + 1;
    },
  };
}

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function baseImplementation(
  partial: Partial<ImplementationResult> & Pick<ImplementationResult, "status" | "sessionId">,
  now: () => Date,
): ImplementationResult {
  const startedAt = now();
  const finishedAt = now();
  return {
    status: partial.status,
    sessionId: partial.sessionId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    stopReason: partial.stopReason ?? "end_turn",
    changedFiles: partial.changedFiles ?? ["src/example.ts"],
    reportedFiles: partial.reportedFiles ?? partial.changedFiles ?? ["src/example.ts"],
    unresolvedItems: partial.unresolvedItems ?? [],
    permissionDecisions: partial.permissionDecisions ?? [],
    mcpPolicyResult: partial.mcpPolicyResult,
    termination: partial.termination,
    artifactPaths: partial.artifactPaths ?? { root: path.join(os.tmpdir(), "meguribi-fake") },
    promptVersion: partial.promptVersion ?? "1",
    promptHash: partial.promptHash ?? "hash",
    publishable: partial.publishable ?? partial.status === "completed",
    error: partial.error,
    secondaryError: partial.secondaryError,
  };
}

function defaultPlan(now: () => Date): PlanArtifact {
  return {
    schemaVersion: 1,
    artifactType: "implementation-plan",
    summary: "Implement the issue",
    requirements: ["req-1"],
    acceptanceCriteria: ["tests pass"],
    outOfScope: [],
    proposedFiles: ["src/example.ts"],
    steps: ["implement", "verify"],
    risks: [],
    tests: ["unit"],
    humanDecisions: [],
    unresolvedItems: [],
    metadata: {
      schemaVersion: 1,
      artifactId: "plan-1",
      createdAt: isoNow(now),
      durationMs: 1,
      producer: { kind: "codex", role: "planner", threadId: "plan-thread" },
      sourceDigests: {},
      eventLog: [],
    },
  };
}

function defaultReview(
  status: ReviewArtifact["status"],
  now: () => Date,
): ReviewArtifact {
  return {
    schemaVersion: 1,
    artifactType: "code-review",
    status,
    summary: status === "approved" ? "Looks good" : "Needs changes",
    requirementCoverage: [],
    findings:
      status === "changes_required"
        ? [
            {
              id: "f1",
              severity: "medium",
              problem: "Missing edge case",
              requiredChange: "Add a unit test",
            },
          ]
        : [],
    missingTests: [],
    scopeViolations: [],
    recommendedAction:
      status === "approved" || status === "approved_with_notes"
        ? "proceed"
        : status === "changes_required"
          ? "fix"
          : "block",
    metadata: {
      schemaVersion: 1,
      artifactId: "review-1",
      createdAt: isoNow(now),
      durationMs: 1,
      producer: { kind: "codex", role: "reviewer", threadId: "review-thread" },
      sourceDigests: {},
      eventLog: [],
    },
  };
}

export interface FakeGitHubOptions {
  issue?: Partial<IssueRecord> & Pick<IssueRecord, "number">;
  pullRequest?: Partial<PullRequestRecord> & Pick<PullRequestRecord, "number">;
  now?: () => Date;
}

export function createFakeGitHubAdapter(options: FakeGitHubOptions = {}): GitHubAdapter & {
  calls: CallCounter;
} {
  const calls = createCounter();
  const now = options.now ?? (() => new Date());
  const issue: IssueRecord = {
    number: options.issue?.number ?? 22,
    title: options.issue?.title ?? "Delivery workflow",
    body: options.issue?.body ?? "Implement delivery support files.",
    labels: options.issue?.labels ?? ["agent:ready"],
    comments: options.issue?.comments ?? [],
    updatedAt: options.issue?.updatedAt ?? isoNow(now),
  };
  const pullRequest: PullRequestRecord = {
    number: options.pullRequest?.number ?? 101,
    url: options.pullRequest?.url ?? "https://example.test/pr/101",
    state: options.pullRequest?.state ?? "closed",
    merged: options.pullRequest?.merged ?? true,
    head: options.pullRequest?.head ?? "meguribi/issue-22",
    headSha: options.pullRequest?.headSha ?? "head-sha",
  };
  let nextPr = 100;

  return {
    calls,
    async getIssue(repository, issueNumber) {
      calls.track("getIssue");
      if (issueNumber !== issue.number) {
        throw new Error(`Issue not found: ${repository}#${String(issueNumber)}`);
      }
      return issue;
    },
    async getPullRequest(repository, pullRequestNumber) {
      calls.track("getPullRequest");
      if (pullRequestNumber !== pullRequest.number) {
        throw new Error(`Pull Request not found: ${repository}#${String(pullRequestNumber)}`);
      }
      return pullRequest;
    },
    async upsertMarkerComment() {
      calls.track("upsertMarkerComment");
      return { commentId: 1 };
    },
    async createDraftPullRequest() {
      calls.track("createDraftPullRequest");
      nextPr += 1;
      return { number: nextPr, url: `https://example.test/pr/${String(nextPr)}` };
    },
    async findDraftPullRequest() {
      calls.track("findDraftPullRequest");
      return null;
    },
  };
}

export interface FakeGitOptions {
  identity?: {
    branch: string;
    headSha: string;
    remoteIdentity: string;
    baseSha?: string;
  };
  /** When set, getIdentity returns this after N calls (for resume mismatch). */
  identityOverrideAfterCalls?: {
    afterCalls: number;
    identity: { branch: string; headSha: string; remoteIdentity: string };
  };
  diff?: {
    changedFiles: readonly string[];
    patch: string;
  };
  now?: () => Date;
}

export function createFakeGitAdapter(options: FakeGitOptions = {}): GitAdapter & {
  calls: CallCounter;
} {
  const calls = createCounter();
  const identity = {
    branch: options.identity?.branch ?? "meguribi/issue-22",
    headSha: options.identity?.headSha ?? "head-sha",
    remoteIdentity: options.identity?.remoteIdentity ?? "github.com/owner/repo",
    baseSha: options.identity?.baseSha ?? "base-sha",
  };
  let getIdentityCalls = 0;

  return {
    calls,
    async ensureWorktree() {
      calls.track("ensureWorktree");
      return {
        baseSha: identity.baseSha,
        headSha: identity.headSha,
        remoteIdentity: identity.remoteIdentity,
      };
    },
    async getIdentity() {
      calls.track("getIdentity");
      getIdentityCalls += 1;
      const override = options.identityOverrideAfterCalls;
      if (override && getIdentityCalls > override.afterCalls) {
        return override.identity;
      }
      return {
        branch: identity.branch,
        headSha: identity.headSha,
        remoteIdentity: identity.remoteIdentity,
      };
    },
    async getDiff() {
      calls.track("getDiff");
      return options.diff
        ? { changedFiles: [...options.diff.changedFiles], patch: options.diff.patch }
        : { changedFiles: ["src/example.ts"], patch: "diff --git a/src/example.ts\n" };
    },
    async commit(input) {
      calls.track("commit");
      identity.headSha = `committed-${input.message.length}`;
      return { headSha: identity.headSha };
    },
    async push() {
      calls.track("push");
    },
    async removeWorktree() {
      calls.track("removeWorktree");
      return { worktreeRemoved: true, branchRemoved: false };
    },
  };
}

export interface FakeVerifierOptions {
  /** Fail verification for the first N calls, then succeed. */
  failFirstN?: number;
  alwaysFail?: boolean;
  now?: () => Date;
  hangUntilAbort?: boolean;
}

export function createFakeVerifier(options: FakeVerifierOptions = {}): Verifier & {
  calls: CallCounter;
} {
  const calls = createCounter();
  const now = options.now ?? (() => new Date());
  let verifyCalls = 0;

  return {
    calls,
    async verify(input) {
      calls.track("verify");
      if (input.abortSignal?.aborted) {
        throw Object.assign(new Error("verification cancelled"), {
          code: "cancelled",
          message: "verification cancelled",
          isRetryable: false,
        });
      }
      if (options.hangUntilAbort) {
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            reject(
              Object.assign(new Error("verification cancelled"), {
                code: "cancelled",
                message: "verification cancelled",
                isRetryable: false,
              }),
            );
          };
          if (input.abortSignal?.aborted) {
            onAbort();
            return;
          }
          input.abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      verifyCalls += 1;
      const fail =
        options.alwaysFail === true ||
        (options.failFirstN !== undefined && verifyCalls <= options.failFirstN);
      const startedAt = isoNow(now);
      const finishedAt = isoNow(now);
      const result: VerificationResult = {
        schemaVersion: 1,
        artifactType: "verification",
        success: !fail,
        commands: [
          {
            name: "test",
            exitCode: fail ? 1 : 0,
            startedAt,
            finishedAt,
            ...(input.logWriter
              ? {
                  logPath: await input.logWriter.write({
                    commandName: "test",
                    commandIndex: 0,
                    stdout: fail ? "fake verification failed" : "fake verification passed",
                    stderr: "",
                    truncated: false,
                  }),
                }
              : {}),
          },
        ],
      };
      return result;
    },
  };
}

export interface FakePolicyOptions {
  publishAllowed?: boolean;
  publishReasons?: string[];
}

export function createFakePolicyEngine(
  options: FakePolicyOptions = {},
): PolicyEngine & { calls: CallCounter } {
  const calls = createCounter();
  return {
    calls,
    async assertReady(input) {
      calls.track("assertReady");
      if (input.requiredLabels.length === 0) {
        throw new Error("requiredLabels must not be empty");
      }
      const missing = input.requiredLabels.filter((label) => !input.labels.includes(label));
      if (missing.length > 0) {
        throw new Error(`Missing required labels: ${missing.join(", ")}`);
      }
    },
    async evaluatePublish(input): Promise<PublishDecision> {
      calls.track("evaluatePublish");
      if (options.publishAllowed === false) {
        return {
          allowed: false,
          reasons: options.publishReasons ?? ["policy blocked"],
        };
      }
      const hits = input.implementation.changedFiles.filter((file) =>
        input.protectedPaths.some((pattern) => {
          const value = file.replaceAll("\\", "/");
          const normalized = pattern.replaceAll("\\", "/");
          if (normalized.endsWith("*")) {
            return value.includes(normalized.slice(0, -1));
          }
          return value === normalized || value.endsWith(`/${normalized}`);
        }),
      );
      if (hits.length > 0) {
        return {
          allowed: false,
          reasons: [`protected path changed without approval: ${hits.join(", ")}`],
        };
      }
      return {
        allowed: true,
        reasons: options.publishReasons ?? [],
      };
    },
  };
}

export interface FakeCodexOptions {
  /** First N reviews return changes_required, then approved. */
  changesRequiredFirstN?: number;
  reviewStatus?: ReviewArtifact["status"];
  now?: () => Date;
}

export function createFakeCodexForDelivery(options: FakeCodexOptions = {}): DeliveryDependencies["codex"] & {
  calls: CallCounter;
} {
  const calls = createCounter();
  const now = options.now ?? (() => new Date());
  let reviewCalls = 0;

  return {
    calls,
    async createPlan() {
      calls.track("createPlan");
      return defaultPlan(now);
    },
    async review() {
      calls.track("review");
      reviewCalls += 1;
      if (
        options.changesRequiredFirstN !== undefined &&
        reviewCalls <= options.changesRequiredFirstN
      ) {
        return defaultReview("changes_required", now);
      }
      return defaultReview(options.reviewStatus ?? "approved", now);
    },
  };
}

export interface FakeDevinOptions {
  /** Cancel when abortSignal is already aborted or aborts during implement. */
  cancelOnAbortSignal?: boolean;
  implementResult?: Partial<ImplementationResult>;
  fixResult?: Partial<ImplementationResult>;
  /** Delay implement so abort can fire mid-flight. */
  implementDelayMs?: number;
  now?: () => Date;
}

/**
 * Fake DevinAdapter — intentionally has only implement/fix.
 * No commit / push / createDraftPullRequest methods exist on this object.
 */
export function createFakeDevinAdapter(options: FakeDevinOptions = {}): DevinAdapter & {
  calls: CallCounter;
} {
  const calls = createCounter();
  const now = options.now ?? (() => new Date());

  const run = async (
    input: ImplementationInput | FixInput,
    kind: "implement" | "fix",
  ): Promise<ImplementationResult> => {
    calls.track(kind);
    if (options.implementDelayMs && options.implementDelayMs > 0 && kind === "implement") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.implementDelayMs);
        input.abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { code: "cancelled" }));
          },
          { once: true },
        );
      }).catch(() => undefined);
    }

    if (options.cancelOnAbortSignal && input.abortSignal?.aborted) {
      return baseImplementation(
        {
          status: "cancelled",
          sessionId: `${kind}-cancelled`,
          publishable: false,
          changedFiles: [],
          stopReason: "cancelled",
          error: {
            code: "cancelled",
            message: "implementation cancelled",
            isRetryable: false,
          },
        },
        now,
      );
    }

    const override = kind === "fix" ? options.fixResult : options.implementResult;
    return baseImplementation(
      {
        status: "completed",
        sessionId: `${kind}-session`,
        publishable: true,
        ...override,
      },
      now,
    );
  };

  return {
    calls,
    implement: (input) => run(input, "implement"),
    fix: (input) => run(input, "fix"),
  };
}

export function createMemoryRunStore(options: { now?: () => Date } = {}): RunStore & {
  calls: CallCounter;
  states: Map<string, RunState>;
  artifacts: Map<string, Map<string, unknown>>;
} {
  const calls = createCounter();
  const now = options.now ?? (() => new Date());
  const states = new Map<string, RunState>();
  const artifacts = new Map<string, Map<string, unknown>>();
  const locks = new Map<string, string>();
  let seq = 0;

  const lockKey = (repository: string, issueNumber: number) =>
    `${repository}#${String(issueNumber)}`;

  return {
    calls,
    states,
    artifacts,
    async create(input) {
      calls.track("create");
      seq += 1;
      const runId = `${now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${seq.toString(16).padStart(6, "0")}`;
      const createdAt = isoNow(now);
      const state: RunState = {
        schemaVersion: 1,
        runId,
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
        createdAt,
        updatedAt: createdAt,
      };
      states.set(runId, state);
      artifacts.set(runId, new Map());
      return structuredClone(state);
    },
    async load(runId) {
      calls.track("load");
      const state = states.get(runId);
      return state ? structuredClone(state) : null;
    },
    async loadLatest(repository, issueNumber) {
      calls.track("loadLatest");
      const matches = [...states.values()]
        .filter((s) => s.repository === repository && s.issueNumber === issueNumber)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return matches[0] ? structuredClone(matches[0]) : null;
    },
    async update(runId, patch) {
      calls.track("update");
      const current = states.get(runId);
      if (!current) {
        throw new Error(`Run not found: ${runId}`);
      }
      const next: RunState = {
        ...current,
        ...patch,
        schemaVersion: 1,
        runId: current.runId,
        repository: current.repository,
        issueNumber: current.issueNumber,
        updatedAt: patch.updatedAt ?? isoNow(now),
      };
      states.set(runId, next);
      return structuredClone(next);
    },
    async saveArtifact(runId, name, value) {
      calls.track("saveArtifact");
      const map = artifacts.get(runId) ?? new Map();
      map.set(name, value);
      artifacts.set(runId, map);
      return `memory://${runId}/${name}`;
    },
    async readArtifact<T>(runId: string, name: string): Promise<T | null> {
      calls.track("readArtifact");
      const value = artifacts.get(runId)?.get(name);
      return value === undefined ? null : (structuredClone(value) as T);
    },
    async acquireLock(input) {
      calls.track("acquireLock");
      const key = lockKey(input.repository, input.issueNumber);
      if (locks.has(key)) {
        throw new Error(`Run lock held by ${locks.get(key)}`);
      }
      locks.set(key, input.runId);
    },
    async releaseLock(input) {
      calls.track("releaseLock");
      locks.delete(lockKey(input.repository, input.issueNumber));
    },
  };
}

export interface FakeDeliveryBundleOptions {
  github?: FakeGitHubOptions;
  git?: FakeGitOptions;
  verifier?: FakeVerifierOptions;
  policy?: FakePolicyOptions;
  codex?: FakeCodexOptions;
  devin?: FakeDevinOptions;
  mcpConfirm?: boolean | (() => Promise<boolean> | boolean);
  now?: () => Date;
}

export function createFakeDeliveryDeps(options: FakeDeliveryBundleOptions = {}): {
  deps: DeliveryDependencies;
  github: ReturnType<typeof createFakeGitHubAdapter>;
  git: ReturnType<typeof createFakeGitAdapter>;
  verifier: ReturnType<typeof createFakeVerifier>;
  policy: ReturnType<typeof createFakePolicyEngine>;
  codex: ReturnType<typeof createFakeCodexForDelivery>;
  devin: ReturnType<typeof createFakeDevinAdapter>;
  runStore: ReturnType<typeof createMemoryRunStore>;
} {
  const now = options.now ?? (() => new Date("2026-07-26T12:00:00.000Z"));
  const github = createFakeGitHubAdapter({ ...options.github, now });
  const git = createFakeGitAdapter({ ...options.git, now });
  const verifier = createFakeVerifier({ ...options.verifier, now });
  const policy = createFakePolicyEngine(options.policy);
  const codex = createFakeCodexForDelivery({ ...options.codex, now });
  const devin = createFakeDevinAdapter({ ...options.devin, now });
  const runStore = createMemoryRunStore({ now });

  const mcpConfirmation: DeliveryMcpConfirmation | undefined =
    options.mcpConfirm === undefined
      ? undefined
      : {
          confirmInheritedMcp: async () =>
            typeof options.mcpConfirm === "function"
              ? await options.mcpConfirm()
              : Boolean(options.mcpConfirm),
        };

  return {
    deps: {
      github,
      git,
      codex,
      implementer: devin,
      devin,
      verifier,
      policy,
      runStore,
      mcpConfirmation,
      now,
      async assertImplementerReady() {
        // Fake bundle assumes implementer preflight already succeeded.
      },
      async assertDevinReady() {
        // Fake bundle assumes Devin preflight already succeeded.
      },
    },
    github,
    git,
    verifier,
    policy,
    codex,
    devin,
    runStore,
  };
}
