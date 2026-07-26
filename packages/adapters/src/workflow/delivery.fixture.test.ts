import { describe, expect, it } from "vitest";
import {
  resumeDelivery,
  runDelivery,
  type ImplementationResult,
  type RunDeliveryInput,
  type RunState,
} from "@meguribi/core";
import { createFakeDeliveryDeps } from "../fakes/delivery-fakes.js";

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
    maxFixAttempts: 2,
    artifactRootForDevin: "/artifacts",
    ...overrides,
  };
}

describe("delivery workflow fixtures", () => {
  it("happy path publishes and uses git/github ports (not Devin)", async () => {
    const bundle = createFakeDeliveryDeps();
    const result = await runDelivery(baseInput(), bundle.deps);

    expect(result.published).toBe(true);
    expect(result.status).toBe("awaiting_human");
    expect(bundle.git.calls.counts.commit).toBe(1);
    expect(bundle.git.calls.counts.push).toBe(1);
    expect(bundle.github.calls.counts.createDraftPullRequest).toBe(1);
    expect(bundle.devin.calls.counts.implement).toBe(1);

    // Devin fake must not expose GitHub/Git publishing methods.
    expect("createDraftPullRequest" in bundle.devin).toBe(false);
    expect("commit" in bundle.devin).toBe(false);
    expect("push" in bundle.devin).toBe(false);
    expect(bundle.devin.calls.counts.createDraftPullRequest).toBeUndefined();
    expect(bundle.devin.calls.counts.commit).toBeUndefined();
  });

  it("blocks MCP warn policy in non-interactive mode", async () => {
    const bundle = createFakeDeliveryDeps();
    const result = await runDelivery(
      baseInput({
        inheritedMcpPolicy: "warn",
        nonInteractive: true,
        allowInheritedMcp: false,
      }),
      bundle.deps,
    );
    expect(result.published).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.reasons.some((r) => /warn policy|non-interactive/i.test(r))).toBe(true);
    expect(bundle.devin.calls.counts.implement).toBeUndefined();
  });

  it("blocks when inherited MCP confirmation is denied", async () => {
    const bundle = createFakeDeliveryDeps({ mcpConfirm: false });
    const result = await runDelivery(
      baseInput({
        inheritedMcpPolicy: "warn",
        nonInteractive: false,
        allowInheritedMcp: false,
      }),
      bundle.deps,
    );
    expect(result.published).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.reasons).toContain("inherited MCP confirmation was denied");
    expect(bundle.devin.calls.counts.implement).toBeUndefined();
  });

  it("cancels via abortSignal before implement", async () => {
    const bundle = createFakeDeliveryDeps();
    const controller = new AbortController();
    controller.abort();
    const result = await runDelivery(baseInput({ abortSignal: controller.signal }), bundle.deps);
    expect(result.status).toBe("cancelled");
    expect(result.reasons).toContain("cancelled before implementation");
    expect(bundle.devin.calls.counts.implement).toBeUndefined();
  });

  it("cancels via abortSignal during implement", async () => {
    const controller = new AbortController();
    const bundle = createFakeDeliveryDeps({
      devin: {
        cancelOnAbortSignal: true,
        implementDelayMs: 80,
      },
    });
    const pending = runDelivery(baseInput({ abortSignal: controller.signal }), bundle.deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(bundle.devin.calls.counts.implement).toBe(1);
    expect(bundle.git.calls.counts.commit).toBeUndefined();
  });

  it("retries after verifier failure then publishes", async () => {
    const bundle = createFakeDeliveryDeps({
      verifier: { failFirstN: 1 },
    });
    const result = await runDelivery(baseInput({ maxFixAttempts: 2 }), bundle.deps);
    expect(result.published).toBe(true);
    expect(bundle.verifier.calls.counts.verify).toBeGreaterThanOrEqual(2);
    expect(bundle.devin.calls.counts.fix).toBe(1);
  });

  it("stops when fix attempt limit is exhausted", async () => {
    const bundle = createFakeDeliveryDeps({
      verifier: { alwaysFail: true },
    });
    const result = await runDelivery(baseInput({ maxFixAttempts: 1 }), bundle.deps);
    expect(result.published).toBe(false);
    expect(result.status).toBe("blocked");
    expect(bundle.devin.calls.counts.fix).toBe(1);
    expect(result.reasons.some((r) => /verification failed/i.test(r))).toBe(true);
  });

  it("fixes after review changes_required then publishes", async () => {
    const bundle = createFakeDeliveryDeps({
      codex: { changesRequiredFirstN: 1 },
    });
    const result = await runDelivery(baseInput({ maxFixAttempts: 2 }), bundle.deps);
    expect(result.published).toBe(true);
    expect(bundle.devin.calls.counts.fix).toBe(1);
    expect(bundle.codex.calls.counts.review).toBeGreaterThanOrEqual(2);
  });

  it("resumes from implementation_completed", async () => {
    const bundle = createFakeDeliveryDeps();
    const first = await runDelivery(baseInput({ noCommit: true, noPush: true, noPr: true }), bundle.deps);
    expect(first.published).toBe(true);

    // Seed a second run stopped after implementation_completed for resume.
    const seeded = createFakeDeliveryDeps();
    const created = await seeded.runStore.create({
      repository: "owner/repo",
      issueNumber: 22,
      command: "run",
      maxFixAttempts: 2,
      identity: {
        repository: "owner/repo",
        issueNumber: 22,
        branch: "meguribi/issue-22",
        worktreePath: "/worktree",
        baseRef: "origin/main",
        baseSha: "base-sha",
        headSha: "head-sha",
        remoteIdentity: "github.com/owner/repo",
      },
    });
    const plan = await seeded.deps.codex.createPlan({
      repositoryPath: "/repo",
      issue: await seeded.deps.github.getIssue("owner/repo", 22),
      repositoryRules: "rules",
      completionCriteria: ["ok"],
      outOfScope: [],
    });
    const implementation: ImplementationResult = {
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
    await seeded.runStore.saveArtifact(created.runId, "plan.json", plan);
    await seeded.runStore.saveArtifact(created.runId, "implementation-result.json", implementation);
    await seeded.runStore.update(created.runId, {
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

    const resumed = await resumeDelivery(
      {
        repository: "owner/repo",
        issueNumber: 22,
        runId: created.runId,
        repositoryPath: "/repo",
        repositoryRules: "Follow AGENTS.md",
        protectedPaths: [".env"],
        verifyCommands: [{ name: "test", run: "pnpm test" }],
        nonInteractive: false,
        allowInheritedMcp: false,
        inheritedMcpPolicy: "allow",
        artifactRootForDevin: "/artifacts",
      },
      seeded.deps,
    );
    expect(resumed.published).toBe(true);
    expect(seeded.git.calls.counts.commit).toBe(1);
    expect(seeded.github.calls.counts.createDraftPullRequest).toBe(1);
    expect(seeded.devin.calls.counts.implement).toBeUndefined();
  });

  it("stops resume on identity mismatch", async () => {
    const bundle = createFakeDeliveryDeps({
      git: {
        identityOverrideAfterCalls: {
          afterCalls: 0,
          identity: {
            branch: "wrong-branch",
            headSha: "wrong-sha",
            remoteIdentity: "wrong-remote",
          },
        },
      },
    });
    const created = await bundle.runStore.create({
      repository: "owner/repo",
      issueNumber: 22,
      command: "run",
      maxFixAttempts: 1,
      identity: {
        repository: "owner/repo",
        issueNumber: 22,
        branch: "meguribi/issue-22",
        worktreePath: "/worktree",
        baseRef: "origin/main",
        baseSha: "base-sha",
        headSha: "head-sha",
        remoteIdentity: "github.com/owner/repo",
      },
    });
    await bundle.runStore.update(created.runId, {
      status: "verifying",
      currentStep: "implementation_completed",
      completedSteps: ["implementation_completed"],
    });
    await bundle.runStore.saveArtifact(created.runId, "plan.json", {
      schemaVersion: 1,
      artifactType: "implementation-plan",
      summary: "plan",
      requirements: [],
      acceptanceCriteria: [],
      outOfScope: [],
      proposedFiles: [],
      steps: [],
      risks: [],
      tests: [],
      humanDecisions: [],
      unresolvedItems: [],
      metadata: {
        schemaVersion: 1,
        artifactId: "p",
        createdAt: "2026-07-26T12:00:00.000Z",
        durationMs: 1,
        producer: { kind: "codex", role: "planner", threadId: "t" },
        sourceDigests: {},
        eventLog: [],
      },
    });
    await bundle.runStore.saveArtifact(created.runId, "implementation-result.json", {
      status: "completed",
      sessionId: "s",
      startedAt: "2026-07-26T12:00:00.000Z",
      finishedAt: "2026-07-26T12:00:01.000Z",
      durationMs: 1,
      changedFiles: [],
      reportedFiles: [],
      unresolvedItems: [],
      permissionDecisions: [],
      artifactPaths: { root: "/a" },
      publishable: true,
    });

    await expect(
      resumeDelivery(
        {
          repository: "owner/repo",
          issueNumber: 22,
          runId: created.runId,
          repositoryPath: "/repo",
          repositoryRules: "rules",
          protectedPaths: [],
          verifyCommands: [],
          nonInteractive: true,
          allowInheritedMcp: false,
          inheritedMcpPolicy: "allow",
          artifactRootForDevin: "/a",
        },
        bundle.deps,
      ),
    ).rejects.toThrow(/identity mismatch/i);
  });

  it("blocks mid-implement resume", async () => {
    const bundle = createFakeDeliveryDeps();
    const created = await bundle.runStore.create({
      repository: "owner/repo",
      issueNumber: 22,
      command: "run",
      maxFixAttempts: 1,
      identity: {
        repository: "owner/repo",
        issueNumber: 22,
        branch: "meguribi/issue-22",
        worktreePath: "/worktree",
        baseRef: "origin/main",
        baseSha: "base-sha",
        headSha: "head-sha",
        remoteIdentity: "github.com/owner/repo",
      },
    });
    const mid: Partial<RunState> = {
      status: "implementing",
      currentStep: "implementing",
      completedSteps: ["planning"],
    };
    await bundle.runStore.update(created.runId, mid);

    const result = await resumeDelivery(
      {
        repository: "owner/repo",
        issueNumber: 22,
        runId: created.runId,
        repositoryPath: "/repo",
        repositoryRules: "rules",
        protectedPaths: [],
        verifyCommands: [],
        nonInteractive: true,
        allowInheritedMcp: false,
        inheritedMcpPolicy: "allow",
        artifactRootForDevin: "/a",
      },
      bundle.deps,
    );
    expect(result.published).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.reasons[0]).toMatch(/Mid-implementation or mid-fix resume/i);
  });

  it("blocks mid-fix resume", async () => {
    const bundle = createFakeDeliveryDeps();
    const created = await bundle.runStore.create({
      repository: "owner/repo",
      issueNumber: 22,
      command: "run",
      maxFixAttempts: 1,
      identity: {
        repository: "owner/repo",
        issueNumber: 22,
        branch: "meguribi/issue-22",
        worktreePath: "/worktree",
        baseRef: "origin/main",
        baseSha: "base-sha",
        headSha: "head-sha",
        remoteIdentity: "github.com/owner/repo",
      },
    });
    await bundle.runStore.update(created.runId, {
      status: "fixing",
      currentStep: "fixing",
      completedSteps: ["implementation_completed", "verifying"],
    });
    const result = await resumeDelivery(
      {
        repository: "owner/repo",
        issueNumber: 22,
        runId: created.runId,
        repositoryPath: "/repo",
        repositoryRules: "rules",
        protectedPaths: [],
        verifyCommands: [],
        nonInteractive: true,
        allowInheritedMcp: false,
        inheritedMcpPolicy: "allow",
        artifactRootForDevin: "/a",
      },
      bundle.deps,
    );
    expect(result.published).toBe(false);
    expect(result.status).toBe("blocked");
  });

  it("blocks publish when protected paths change", async () => {
    const bundle = createFakeDeliveryDeps({
      devin: {
        implementResult: {
          status: "completed",
          sessionId: "protected",
          changedFiles: [".env.local"],
          reportedFiles: [".env.local"],
          publishable: true,
        },
      },
    });
    const result = await runDelivery(baseInput({ protectedPaths: [".env*"] }), bundle.deps);
    expect(result.published).toBe(false);
    expect(result.reasons.some((reason) => /protected path/i.test(reason))).toBe(true);
  });

  it("does not re-publish when resume finds awaiting_human", async () => {
    const bundle = createFakeDeliveryDeps();
    const created = await bundle.runStore.create({
      repository: "owner/repo",
      issueNumber: 22,
      command: "run",
      maxFixAttempts: 1,
      identity: {
        repository: "owner/repo",
        issueNumber: 22,
        branch: "meguribi/issue-22",
        worktreePath: "/worktree",
        baseRef: "origin/main",
        baseSha: "base-sha",
        headSha: "head-sha",
        remoteIdentity: "github.com/owner/repo",
      },
    });
    const plan = await bundle.deps.codex.createPlan({
      repositoryPath: "/repo",
      issue: await bundle.deps.github.getIssue("owner/repo", 22),
      repositoryRules: "rules",
      completionCriteria: ["ok"],
      outOfScope: [],
    });
    const implementation: ImplementationResult = {
      status: "completed",
      sessionId: "done",
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
    await bundle.runStore.saveArtifact(created.runId, "plan.json", plan);
    await bundle.runStore.saveArtifact(created.runId, "implementation-result.json", implementation);
    await bundle.runStore.update(created.runId, {
      status: "awaiting_human",
      currentStep: "awaiting_human",
      completedSteps: [
        "implementation_completed",
        "verifying",
        "reviewing",
        "publishing",
        "awaiting_human",
      ],
      pullRequestNumber: 99,
    });
    const result = await resumeDelivery(
      {
        repository: "owner/repo",
        issueNumber: 22,
        runId: created.runId,
        repositoryPath: "/repo",
        repositoryRules: "rules",
        protectedPaths: [".env*"],
        verifyCommands: [{ name: "test", run: "pnpm test" }],
        nonInteractive: true,
        allowInheritedMcp: false,
        inheritedMcpPolicy: "allow",
        artifactRootForDevin: "/a",
      },
      bundle.deps,
    );
    expect(result.published).toBe(true);
    expect(result.pullRequestNumber).toBe(99);
    expect(bundle.git.calls.counts.commit).toBeUndefined();
    expect(result.reasons[0]).toMatch(/will not be repeated/i);
  });
});
