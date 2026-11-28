import { describe, expect, it } from "vitest";
import {
  approveDiscussion,
  continueDiscussToPrAfterApproval,
  runDiscussToPr,
  type DiscussToPrDependencies,
  type DiscussionDependencies,
  type RunDiscussToPrInput,
  type SpecificationContent,
} from "@meguribi/core";
import { hashConclusion } from "../discussion/summarize.js";
import { parseDiscussionEnvelope } from "../discussion/envelope.js";
import { summarizeDiscussion } from "../discussion/summarize.js";
import { buildSummarizerPrompt } from "@meguribi/core";
import {
  createFakeDeliveryDeps,
  createFakeDiscussionRoleAgent,
  type FakeDeliveryBundleOptions,
} from "../fakes/delivery-fakes.js";
import type { AgentProfile } from "@meguribi/core";

function profile(id: string): AgentProfile {
  return { id, kind: "claude-code", transport: "acp" } as unknown as AgentProfile;
}

function baseInput(overrides: Partial<RunDiscussToPrInput> = {}): RunDiscussToPrInput {
  return {
    repository: "owner/repo",
    issueNumber: 22,
    repositoryPath: "/repo",
    worktreePath: "/worktree",
    branch: "meguribi/issue-96",
    baseRef: "origin/main",
    requiredLabels: ["agent:ready"],
    repositoryRules: "Follow AGENTS.md",
    limits: { maxTurns: 8, maxDurationMs: 60_000, turnTimeoutMs: 1_000 },
    nonInteractive: true,
    artifactRoot: "/artifacts",
    outOfScope: [],
    protectedPaths: [".env"],
    verifyCommands: [{ name: "test", run: "pnpm test" }],
    inheritedMcpPolicy: "allow",
    allowInheritedMcp: false,
    maxFixAttempts: 2,
    artifactRootForDevin: "/artifacts",
    ...overrides,
  };
}

function createBundle(options: FakeDeliveryBundleOptions = {}) {
  const deliveryBundle = createFakeDeliveryDeps(options);
  const runStore = deliveryBundle.runStore;
  const discussionStoreData = new Map<string, { conclusion: unknown }>();
  const createStore = (runId: string) => {
    const data = { turns: [] as never[], conclusion: null as never, humanMessages: [] as never[] };
    void data;
    return {
      async appendTurn() {},
      async readTurns() { return []; },
      async readHumanMessages() { return []; },
      async saveConclusion(conclusion: unknown) {
        // runStore にも永続化し、復帰時の再読込を再現する
        await runStore.saveArtifact(runId, "discussion/conclusion.json", conclusion);
        discussionStoreData.set(runId, { conclusion });
      },
      async readConclusion() {
        return (await runStore.readArtifact(runId, "discussion/conclusion.json")) as never;
      },
    };
  };
  const discussion: DiscussionDependencies = {
    github: deliveryBundle.deps.github,
    git: deliveryBundle.deps.git,
    policy: deliveryBundle.deps.policy,
    runStore,
    discussants: [createFakeDiscussionRoleAgent(profile("claude-code")), createFakeDiscussionRoleAgent(profile("codex-acp"))],
    summarizer: {
      ...createFakeDiscussionRoleAgent(profile("claude-code")),
      async openSession() {
        return {
          sessionId: "fake-summarizer",
          async send() {
            return {
              sessionId: "fake-summarizer",
              text: "```json\n" + JSON.stringify({
                topic: "fixture topic",
                conclusion: "fixture conclusion",
                issues: [],
                rejectedOptions: [],
                openQuestions: [],
                acceptanceCriteriaSeeds: ["承認ゲートで停止すること", "PR が作成されること"],
              }) + "\n```",
              events: [],
            };
          },
          async close() {},
        };
      },
    } as never,
    createStore: createStore as never,
    parseEnvelope: parseDiscussionEnvelope,
    summarize: (input) => summarizeDiscussion(input, buildSummarizerPrompt),
    hashConclusion,
    now: () => new Date(),
  };
  const prBodies: string[] = [];
  const github = {
    ...deliveryBundle.deps.github,
    async createDraftPullRequest(input: { body: string }) {
      prBodies.push(input.body);
      return deliveryBundle.deps.github.createDraftPullRequest(input as never);
    },
  } as never;
  const deps: DiscussToPrDependencies = {
    discussion,
    delivery: { ...deliveryBundle.deps, github },
    specify: async ({ conclusion }) => {
      const content: SpecificationContent = {
        problem: null,
        targetUsers: [],
        requirements: [],
        acceptanceCriteria: conclusion.acceptanceCriteriaSeeds.map((seed, index) => ({
          id: `ac-${String(index + 1)}`,
          seed,
          given: "前提",
          when: "操作",
          // oxlint-disable-next-line unicorn/no-thenable -- スキーマのデータフィールド
          then: seed,
          requirementIds: [],
        })),
        inScope: ["scope-a"],
        outOfScope: [],
        testPlan: [],
        successMetrics: [],
        guardrails: [],
        openQuestions: [],
      };
      return content;
    },
    now: () => new Date(),
  };
  return { deps, deliveryBundle, runStore, prBodies };
}

async function runToApproval(bundle: ReturnType<typeof createBundle>): Promise<string> {
  const phase1 = await runDiscussToPr(baseInput(), bundle.deps);
  expect(phase1.status).toBe("awaiting_human");
  await approveDiscussion(
    { runId: phase1.runId, approver: "fixture-approver" },
    {
      runStore: bundle.runStore,
      createStore: bundle.deps.discussion.createStore,
      hashConclusion,
      now: () => new Date(),
    },
  );
  return phase1.runId;
}

describe("discuss-to-pr fixtures", () => {
  it("runs Issue through discussion, approval, specification and Draft PR with fake agents", async () => {
    const bundle = createBundle();
    const runId = await runToApproval(bundle);
    const result = await continueDiscussToPrAfterApproval({ runId }, bundle.deps);

    expect(result.published).toBe(true);
    expect(bundle.deliveryBundle.devin.calls.counts.implement).toBe(1);
    expect(bundle.deliveryBundle.github.calls.counts.createDraftPullRequest).toBe(1);

    // 仕様は RunStore に保存される
    const specification = await bundle.runStore.readArtifact<{ acceptanceCriteria: unknown[] }>(runId, "specification.json");
    expect(specification).not.toBeNull();
    expect(specification?.acceptanceCriteria.length).toBeGreaterThan(0);

    // PR 本文に受け入れ条件が載る
    expect(bundle.prBodies.length).toBe(1);
    expect(bundle.prBodies[0]).toContain("## 受け入れ条件");
    expect(bundle.prBodies[0]).toContain("Given");
    expect(bundle.prBodies[0]).toContain("承認ゲートで停止すること");
  });

  it("does not re-implement or create a second PR when continuation is invoked again", async () => {
    const bundle = createBundle();
    const runId = await runToApproval(bundle);
    const first = await continueDiscussToPrAfterApproval({ runId }, bundle.deps);
    expect(first.published).toBe(true);

    // 承認プロセスの再実行（途中失敗後の復帰を含む）: 完了済み工程は再実行しない
    const second = await continueDiscussToPrAfterApproval({ runId }, bundle.deps);
    expect(second.published).toBe(true);
    expect(bundle.deliveryBundle.devin.calls.counts.implement).toBe(1);
    expect(bundle.deliveryBundle.github.calls.counts.createDraftPullRequest).toBe(1);
  });

  it("saves the continuation config before awaiting_human is observable", async () => {
    const bundle = createBundle();
    let observedConfig: unknown = null;
    bundle.deps.discussion.onStateChange = async (state) => {
      if (state.status === "awaiting_human") {
        observedConfig = await bundle.runStore.readArtifact(state.runId, "discuss-to-pr.json");
      }
    };

    const phase1 = await runDiscussToPr(baseInput(), bundle.deps);

    expect(phase1.status).toBe("awaiting_human");
    expect(observedConfig).not.toBeNull();
  });

  it("does not publish an approvable awaiting_human state when continuation persistence fails", async () => {
    const bundle = createBundle();
    const originalSaveArtifact = bundle.runStore.saveArtifact.bind(bundle.runStore);
    bundle.runStore.saveArtifact = async (runId, name, value) => {
      if (name === "discuss-to-pr.json") {
        throw new Error("injected continuation save failure");
      }
      return originalSaveArtifact(runId, name, value);
    };
    const publishedStatuses: string[] = [];
    bundle.deps.discussion.onStateChange = (state) => {
      publishedStatuses.push(state.status);
    };

    const phase1 = await runDiscussToPr(baseInput(), bundle.deps);

    expect(phase1.status).toBe("failed");
    expect(phase1.reasons.join("\n")).toContain("injected continuation save failure");
    const state = await bundle.runStore.load(phase1.runId);
    expect(state?.status).toBe("failed");
    expect(publishedStatuses).not.toContain("awaiting_human");
    await expect(
      approveDiscussion(
        { runId: phase1.runId, approver: "fixture-approver" },
        {
          runStore: bundle.runStore,
          createStore: bundle.deps.discussion.createStore,
          hashConclusion,
          now: () => new Date(),
        },
      ),
    ).rejects.toThrow();
  });

  it("carries maxFixAttempts into continuation and executes the verify fix loop", async () => {
    const bundle = createBundle({ verifier: { failFirstN: 1 } });
    const runId = await runToApproval(bundle);

    const result = await continueDiscussToPrAfterApproval({ runId }, bundle.deps);

    expect(result.published).toBe(true);
    expect(bundle.deliveryBundle.devin.calls.counts.fix).toBe(1);
    expect(bundle.deliveryBundle.verifier.calls.counts.verify).toBe(2);
    const state = await bundle.runStore.load(runId);
    expect(state?.maxFixAttempts).toBe(2);
    expect(state?.fixAttempts).toBe(1);
  });

  it("executes the review fix loop when review requires changes once", async () => {
    const bundle = createBundle({ codex: { changesRequiredFirstN: 1 } });
    const runId = await runToApproval(bundle);

    const result = await continueDiscussToPrAfterApproval({ runId }, bundle.deps);

    expect(result.published).toBe(true);
    expect(bundle.deliveryBundle.devin.calls.counts.fix).toBe(1);
    expect(bundle.deliveryBundle.codex.calls.counts.review).toBe(2);
    const state = await bundle.runStore.load(runId);
    expect(state?.fixAttempts).toBe(1);
  });

  it("stops when the conclusion hash no longer matches the approval", async () => {
    const bundle = createBundle();
    const runId = await runToApproval(bundle);
    // 承認後に結論を差し替える
    const conclusion = await bundle.runStore.readArtifact<Record<string, unknown>>(runId, "discussion/conclusion.json");
    await bundle.runStore.saveArtifact(runId, "discussion/conclusion.json", {
      ...conclusion,
      conclusion: "tampered conclusion",
    });

    await expect(continueDiscussToPrAfterApproval({ runId }, bundle.deps)).rejects.toThrow();
    expect(bundle.deliveryBundle.devin.calls.counts.implement).toBeUndefined();
  });
});
