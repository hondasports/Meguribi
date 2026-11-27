import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  resumeDelivery,
  runDelivery,
  type DeliveryResult,
  type ImplementationResult,
  type RunDeliveryInput,
  type RunState,
} from "@meguribi/core";
import { createFakeDeliveryDeps } from "../fakes/delivery-fakes.js";
import { withDeliveryTrace, type DeliveryTrace } from "./delivery-trace.js";

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

function resumeInput(overrides: Record<string, unknown> = {}) {
  return {
    repository: "owner/repo",
    issueNumber: 22,
    repositoryPath: "/repo",
    repositoryRules: "rules",
    protectedPaths: [],
    verifyCommands: [],
    nonInteractive: true,
    allowInheritedMcp: false,
    inheritedMcpPolicy: "allow" as const,
    artifactRootForDevin: "/a",
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

function seedImplementation(sessionId: string): ImplementationResult {
  return {
    status: "completed",
    sessionId,
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

async function seedRun(
  bundle: ReturnType<typeof createFakeDeliveryDeps>,
  patch: Partial<RunState>,
  maxFixAttempts = 1,
): Promise<string> {
  const created = await bundle.runStore.create({
    repository: "owner/repo",
    issueNumber: 22,
    command: "run",
    maxFixAttempts,
    identity,
  });
  await bundle.runStore.update(created.runId, patch);
  return created.runId;
}

function fillResult(trace: DeliveryTrace, result: DeliveryResult): void {
  trace.result = {
    status: result.status,
    published: result.published,
    reasons: result.reasons,
    pullRequestNumber: result.pullRequestNumber,
  };
}

async function traced<T>(
  bundle: ReturnType<typeof createFakeDeliveryDeps>,
  trace: DeliveryTrace,
  invoke: (deps: Parameters<typeof withDeliveryTrace>[0]) => Promise<T>,
): Promise<T> {
  const wrapped = withDeliveryTrace(bundle.deps);
  // 1つのシナリオで複数の delivery 呼び出しをトレースするときは、
  // 同じ states / calls 配列を共有させる。
  wrapped.trace.states.push(...trace.states);
  wrapped.trace.calls.push(...trace.calls);
  trace.states = wrapped.trace.states;
  trace.calls = wrapped.trace.calls;
  try {
    const result = await invoke(wrapped.deps);
    if (typeof result === "object" && result !== null && "status" in result && "published" in result) {
      fillResult(trace, result as DeliveryResult);
    }
    return result;
  } catch (error) {
    trace.thrownError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

interface Scenario {
  name: string;
  run: () => Promise<DeliveryTrace>;
}

function scenario(name: string, body: (trace: DeliveryTrace) => Promise<void>): Scenario {
  return {
    name,
    run: async () => {
      const trace: DeliveryTrace = { states: [], calls: [] };
      await body(trace);
      return trace;
    },
  };
}

const scenarios: Scenario[] = [
  scenario("happy path publishes and uses git/github ports (not Devin)", async (trace) => {
    const bundle = createFakeDeliveryDeps();
    await traced(bundle, trace, (deps) => runDelivery(baseInput(), deps));
  }),

  scenario("passes the implementation worktree to Codex review", async (trace) => {
    const bundle = createFakeDeliveryDeps();
    const codex = {
      ...bundle.deps.codex,
      review: (input: Parameters<typeof bundle.deps.codex.review>[0]) =>
        bundle.deps.codex.review(input),
    };
    await traced(bundle, trace, (deps) => runDelivery(baseInput(), { ...deps, codex }));
  }),

  scenario("blocks MCP warn policy in non-interactive mode", async (trace) => {
    const bundle = createFakeDeliveryDeps();
    await traced(bundle, trace, (deps) =>
      runDelivery(
        baseInput({ inheritedMcpPolicy: "warn", nonInteractive: true, allowInheritedMcp: false }),
        deps,
      ),
    );
  }),

  scenario("blocks when inherited MCP confirmation is denied", async (trace) => {
    const bundle = createFakeDeliveryDeps({ mcpConfirm: false });
    await traced(bundle, trace, (deps) =>
      runDelivery(
        baseInput({ inheritedMcpPolicy: "warn", nonInteractive: false, allowInheritedMcp: false }),
        deps,
      ),
    );
  }),

  scenario("cancels via abortSignal before implement", async (trace) => {
    const bundle = createFakeDeliveryDeps();
    const controller = new AbortController();
    controller.abort();
    await traced(bundle, trace, (deps) =>
      runDelivery(baseInput({ abortSignal: controller.signal }), deps),
    );
  }),

  scenario("cancels via abortSignal during implement", async (trace) => {
    const controller = new AbortController();
    const bundle = createFakeDeliveryDeps({
      devin: { cancelOnAbortSignal: true, implementDelayMs: 80 },
    });
    const pending = traced(bundle, trace, (deps) =>
      runDelivery(baseInput({ abortSignal: controller.signal }), deps),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await pending;
  }),

  scenario("cancels during verification and does not publish", async (trace) => {
    const controller = new AbortController();
    const bundle = createFakeDeliveryDeps({ verifier: { hangUntilAbort: true } });
    const pending = traced(bundle, trace, (deps) =>
      runDelivery(baseInput({ abortSignal: controller.signal }), deps),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await pending;
  }),

  scenario("retries after verifier failure then publishes", async (trace) => {
    const bundle = createFakeDeliveryDeps({ verifier: { failFirstN: 1 } });
    await traced(bundle, trace, (deps) => runDelivery(baseInput({ maxFixAttempts: 2 }), deps));
  }),

  scenario("stops when fix attempt limit is exhausted", async (trace) => {
    const bundle = createFakeDeliveryDeps({ verifier: { alwaysFail: true } });
    await traced(bundle, trace, (deps) => runDelivery(baseInput({ maxFixAttempts: 1 }), deps));
  }),

  scenario("fixes after review changes_required then publishes", async (trace) => {
    const bundle = createFakeDeliveryDeps({ codex: { changesRequiredFirstN: 1 } });
    await traced(bundle, trace, (deps) => runDelivery(baseInput({ maxFixAttempts: 2 }), deps));
  }),

  scenario("uses the remaining fix attempts when review still requires changes", async (trace) => {
    const bundle = createFakeDeliveryDeps({ codex: { changesRequiredFirstN: 2 } });
    await traced(bundle, trace, (deps) => runDelivery(baseInput({ maxFixAttempts: 2 }), deps));
  }),

  scenario("resumes from implementation_completed", async (trace) => {
    const bundle = createFakeDeliveryDeps();
    await traced(bundle, trace, (deps) =>
      runDelivery(baseInput({ noCommit: true, noPush: true, noPr: true }), deps),
    );

    const seeded = createFakeDeliveryDeps();
    const created = await seeded.runStore.create({
      repository: "owner/repo",
      issueNumber: 22,
      command: "run",
      maxFixAttempts: 2,
      identity,
    });
    const plan = await seeded.deps.codex.createPlan({
      repositoryPath: "/repo",
      issue: await seeded.deps.github.getIssue("owner/repo", 22),
      repositoryRules: "rules",
      completionCriteria: ["ok"],
      outOfScope: [],
    });
    await seeded.runStore.saveArtifact(created.runId, "plan.json", plan);
    await seeded.runStore.saveArtifact(
      created.runId,
      "implementation-result.json",
      seedImplementation("seed-session"),
    );
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

    await traced(seeded, trace, (deps) =>
      resumeDelivery(
        {
          ...resumeInput({
            runId: created.runId,
            repositoryRules: "Follow AGENTS.md",
            protectedPaths: [".env"],
            verifyCommands: [{ name: "test", run: "pnpm test" }],
            nonInteractive: false,
            artifactRootForDevin: "/artifacts",
          }),
        } as Parameters<typeof resumeDelivery>[0],
        deps,
      ),
    );
  }),

  scenario("stops resume on identity mismatch", async (trace) => {
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
      identity,
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

    await traced(bundle, trace, (deps) =>
      resumeDelivery(
        { ...resumeInput({ runId: created.runId }) } as Parameters<typeof resumeDelivery>[0],
        deps,
      ),
    ).catch(() => undefined);
  }),

  scenario("blocks mid-implement resume", async (trace) => {
    const bundle = createFakeDeliveryDeps();
    const runId = await seedRun(bundle, {
      status: "implementing",
      currentStep: "implementing",
      completedSteps: ["planning"],
    });
    await traced(bundle, trace, (deps) =>
      resumeDelivery(
        { ...resumeInput({ runId }) } as Parameters<typeof resumeDelivery>[0],
        deps,
      ),
    );
  }),

  scenario("blocks mid-fix resume", async (trace) => {
    const bundle = createFakeDeliveryDeps();
    const runId = await seedRun(bundle, {
      status: "fixing",
      currentStep: "fixing",
      completedSteps: ["implementation_completed", "verifying"],
    });
    await traced(bundle, trace, (deps) =>
      resumeDelivery(
        { ...resumeInput({ runId }) } as Parameters<typeof resumeDelivery>[0],
        deps,
      ),
    );
  }),

  scenario("blocks publish when protected paths change", async (trace) => {
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
    await traced(bundle, trace, (deps) =>
      runDelivery(baseInput({ protectedPaths: [".env*"] }), deps),
    );
  }),

  scenario("does not re-publish when resume finds awaiting_human", async (trace) => {
    const bundle = createFakeDeliveryDeps();
    const created = await bundle.runStore.create({
      repository: "owner/repo",
      issueNumber: 22,
      command: "run",
      maxFixAttempts: 1,
      identity,
    });
    const plan = await bundle.deps.codex.createPlan({
      repositoryPath: "/repo",
      issue: await bundle.deps.github.getIssue("owner/repo", 22),
      repositoryRules: "rules",
      completionCriteria: ["ok"],
      outOfScope: [],
    });
    await bundle.runStore.saveArtifact(created.runId, "plan.json", plan);
    await bundle.runStore.saveArtifact(
      created.runId,
      "implementation-result.json",
      seedImplementation("done"),
    );
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
    await traced(bundle, trace, (deps) =>
      resumeDelivery(
        {
          ...resumeInput({
            runId: created.runId,
            protectedPaths: [".env*"],
            verifyCommands: [{ name: "test", run: "pnpm test" }],
          }),
        } as Parameters<typeof resumeDelivery>[0],
        deps,
      ),
    );
  }),
];

const goldenPath = new URL("./__golden__/delivery-traces.json", import.meta.url);

type GoldenFile = Record<string, DeliveryTrace>;

async function readGolden(): Promise<GoldenFile> {
  const raw = await fs.readFile(goldenPath, "utf8");
  return JSON.parse(raw) as GoldenFile;
}

async function recordGolden(name: string, trace: DeliveryTrace): Promise<void> {
  let existing: GoldenFile = {};
  try {
    existing = await readGolden();
  } catch {
    // first generation
  }
  existing[name] = trace;
  await fs.mkdir(new URL("./", goldenPath), { recursive: true });
  await fs.writeFile(goldenPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

describe("delivery behavior traces", () => {
  it.each(scenarios)("$name keeps the recorded delivery trace", async ({ name, run }) => {
    const trace = await run();
    if (process.env.MEGURIBI_UPDATE_GOLDEN === "1") {
      await recordGolden(name, trace);
      return;
    }
    const golden = await readGolden();
    expect(trace).toEqual(golden[name]);
  });
});
