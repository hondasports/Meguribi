import { describe, expect, it } from "vitest";
import {
  resumeDelivery,
  runDelivery,
  type ImplementationResult,
  type ResumeDeliveryInput,
  type RunDeliveryInput,
  type Verifier,
} from "@meguribi/core";
import { createFakeDeliveryDeps } from "../fakes/delivery-fakes.js";

type FakeDeliveryBundle = ReturnType<typeof createFakeDeliveryDeps>;

function baseInput(overrides: Partial<RunDeliveryInput> = {}): RunDeliveryInput {
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
    protectedPaths: [".env"],
    verifyCommands: [{ name: "test", run: "pnpm test" }],
    inheritedMcpPolicy: "allow",
    allowInheritedMcp: false,
    nonInteractive: false,
    maxFixAttempts: 1,
    artifactRootForDevin: "/artifacts",
    ...overrides,
  };
}

function resumeInput(overrides: Partial<ResumeDeliveryInput> = {}): ResumeDeliveryInput {
  return {
    repository: "owner/repo",
    issueNumber: 22,
    repositoryPath: "/repo",
    repositoryRules: "rules",
    protectedPaths: [".env"],
    verifyCommands: [{ name: "test", run: "pnpm test" }],
    nonInteractive: true,
    allowInheritedMcp: false,
    inheritedMcpPolicy: "allow",
    artifactRootForDevin: "/artifacts",
    ...overrides,
  };
}

const identity = {
  repository: "owner/repo",
  issueNumber: 22,
  branch: "meguribi/issue-22",
  worktreePath: "/worktree",
  baseRef: "origin/main",
  baseSha: "base-sha",
  headSha: "head-sha",
  remoteIdentity: "github.com/owner/repo",
};

function seedImplementation(): ImplementationResult {
  return {
    status: "completed",
    sessionId: "seed-session",
    startedAt: "2026-07-26T12:00:00.000Z",
    finishedAt: "2026-07-26T12:01:00.000Z",
    durationMs: 60_000,
    changedFiles: ["src/example.ts"],
    reportedFiles: ["src/example.ts"],
    unresolvedItems: [],
    permissionDecisions: [],
    artifactPaths: { root: "/artifacts" },
    publishable: true,
  };
}

function createLockProbingVerifier(bundle: FakeDeliveryBundle): {
  verifier: Verifier;
  getAssertionError: () => unknown;
} {
  let assertionError: unknown;
  const verifier: Verifier = {
    async verify(input) {
      try {
        await expect(
          bundle.runStore.acquireLock({
            repository: "owner/repo",
            issueNumber: 22,
            runId: "second-delivery-probe",
          }),
        ).rejects.toThrow(/Run lock held/);
      } catch (error) {
        assertionError = error;
      }
      return bundle.deps.verifier.verify(input);
    },
  };
  return {
    verifier,
    getAssertionError: () => assertionError,
  };
}

function throwLockProbeAssertionError(probe: { getAssertionError: () => unknown }): void {
  const assertionError = probe.getAssertionError();
  if (assertionError !== undefined) {
    throw assertionError;
  }
}

async function seedResumableRun(bundle: FakeDeliveryBundle): Promise<string> {
  const created = await bundle.runStore.create({
    repository: "owner/repo",
    issueNumber: 22,
    command: "run",
    maxFixAttempts: 1,
    identity,
  });
  const issue = await bundle.deps.github.getIssue("owner/repo", 22);
  const plan = await bundle.deps.codex.createPlan({
    repositoryPath: "/repo",
    issue,
    repositoryRules: "rules",
    completionCriteria: ["ok"],
    outOfScope: [],
  });
  await bundle.runStore.saveArtifact(created.runId, "plan.json", plan);
  await bundle.runStore.saveArtifact(
    created.runId,
    "implementation-result.json",
    seedImplementation(),
  );
  await bundle.runStore.update(created.runId, {
    status: "verifying",
    currentStep: "implementation_completed",
    completedSteps: [
      "context",
      "preflight",
      "awaiting_mcp_confirmation",
      "worktree",
      "planning",
      "implementation_completed",
    ],
  });
  return created.runId;
}

describe("delivery issue lock fixtures", () => {
  it("keeps the issue lock while runDelivery is verifying", async () => {
    const bundle = createFakeDeliveryDeps();
    const probe = createLockProbingVerifier(bundle);

    const result = await runDelivery(baseInput(), {
      ...bundle.deps,
      verifier: probe.verifier,
    });

    throwLockProbeAssertionError(probe);
    expect(result.published).toBe(true);
    expect(bundle.runStore.calls.counts.acquireLock).toBe(2);
    expect(bundle.runStore.calls.counts.releaseLock).toBe(1);
  });

  it("keeps the issue lock while resumeDelivery is verifying", async () => {
    const bundle = createFakeDeliveryDeps();
    const runId = await seedResumableRun(bundle);
    const probe = createLockProbingVerifier(bundle);

    const result = await resumeDelivery(resumeInput({ runId }), {
      ...bundle.deps,
      verifier: probe.verifier,
    });

    throwLockProbeAssertionError(probe);
    expect(result.published).toBe(true);
    expect(bundle.runStore.calls.counts.acquireLock).toBe(2);
    expect(bundle.runStore.calls.counts.releaseLock).toBe(1);
  });
});
