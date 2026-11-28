import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveDiscussion,
  continueDiscussToPrAfterApproval,
  runDiscussToPr,
  RoleAssignmentError,
  type AgentAdapter,
  type AgentDiagnosis,
  type AgentProfile,
  type RoleAgent,
  type RunDiscussToPrInput,
} from "@meguribi/core";
import {
  createDeliveryDeps,
  createDiscussToPrDependencies,
} from "./create-delivery-deps.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-dtp-wiring-"));
  tempDirs.push(dir);
  return dir;
}

const healthyAcpDiagnosis: AgentDiagnosis = {
  executable: { status: "ok", path: "claude-agent-acp" },
  version: { status: "unknown" },
  authentication: { status: "unknown" },
  acp: { status: "supported" },
  inheritedMcpPolicy: "allow",
  runnable: true,
  warnings: [],
  errors: [],
};

function acpProfile(id: string): AgentProfile {
  return {
    id,
    kind: "claude-code",
    transport: "acp",
    executable: `${id}-executable`,
    startupTimeoutMs: 1_000,
    turnTimeoutMinutes: 5,
    inheritedMcpPolicy: "allow",
  };
}

function sdkCodexProfile(id: string): AgentProfile {
  return {
    id,
    kind: "codex",
    transport: "sdk",
    startupTimeoutMs: 1_000,
    turnTimeoutMinutes: 5,
    inheritedMcpPolicy: "allow",
  };
}

function uniqueProfiles(ids: readonly string[]): AgentProfile[] {
  return [...new Set(ids)].map(acpProfile);
}

function agentsResult(input: {
  discussants?: readonly string[];
  planner?: string;
  implementer?: string;
  reviewer?: string;
  specifier?: string;
  allowSameImplementerReviewer?: boolean;
  extraProfiles?: readonly AgentProfile[];
}) {
  const discussants = input.discussants ?? ["alpha", "beta"];
  const planner = input.planner ?? "planner";
  const implementer = input.implementer ?? "implementer";
  const reviewer = input.reviewer ?? "reviewer";
  const baseIds = [
    ...discussants,
    planner,
    implementer,
    reviewer,
    ...(input.specifier !== undefined ? [input.specifier] : []),
  ];
  const overrides = new Map((input.extraProfiles ?? []).map((profile) => [profile.id, profile]));
  const profiles = [
    ...uniqueProfiles(baseIds).map((profile) => overrides.get(profile.id) ?? profile),
    ...(input.extraProfiles ?? []).filter((profile) => !baseIds.includes(profile.id)),
  ];
  return {
    profiles,
    roles: {
      discussants: [...discussants],
      planner,
      implementer,
      reviewer,
      ...(input.specifier !== undefined ? { specifier: input.specifier } : {}),
      allowSameImplementerReviewer: input.allowSameImplementerReviewer ?? false,
    },
    snapshot: {},
  };
}

function unusedRoleAgent(profileId: string): RoleAgent {
  return {
    profileId,
    kind: "claude-code",
    async openSession() {
      throw new Error(`unexpected role session: ${profileId}`);
    },
  };
}

function unusedImplementer(): AgentAdapter {
  return {
    implement: async () => {
      throw new Error("not used");
    },
    fix: async () => {
      throw new Error("not used");
    },
  };
}

function harness(agents: unknown, overrides: Record<string, unknown> = {}) {
  const implementerOptions: unknown[] = [];
  const diagnoseOptions: unknown[] = [];
  const roleAgentProfiles: string[] = [];
  const options = {
    cwd: "C:/fixture/repository",
    repositoryPath: "C:/fixture/repository",
    repository: "owner/repo",
    localOnly: true,
    nonInteractive: true,
    loadAgentsConfig: async () => agents,
    loadImplementerConfig: async () => ({
      kind: "acp-server",
      profile: acpProfile("implementer"),
      snapshot: {},
    }),
    diagnoseAcpServer: async (input: unknown) => {
      diagnoseOptions.push(input);
      return healthyAcpDiagnosis;
    },
    createAcpServerImplementer: (input: unknown) => {
      implementerOptions.push(input);
      return unusedImplementer();
    },
    createAcpRoleAgent: (input: { profile: AgentProfile }) => {
      roleAgentProfiles.push(input.profile.id);
      return unusedRoleAgent(input.profile.id);
    },
    createRoleAgentPlanningBridge: () => ({
      createPlan: async () => {
        throw new Error("not used");
      },
      review: async () => {
        throw new Error("not used");
      },
    }),
    createCodexBridge: () => ({
      createPlan: async () => {
        throw new Error("not used");
      },
      review: async () => {
        throw new Error("not used");
      },
    }),
    ...overrides,
  };
  return { options, implementerOptions, diagnoseOptions, roleAgentProfiles };
}

describe("createDiscussToPrDependencies safety wiring", () => {
  it("uses the same implementer safety settings as normal delivery wiring", async () => {
    const agents = agentsResult({});
    const first = harness(agents);
    const normal = await createDeliveryDeps(first.options as never);
    const second = harness(agents);
    const discussToPr = await createDiscussToPrDependencies(second.options as never);

    expect(discussToPr.inheritedMcpPolicy).toBe(normal.inheritedMcpPolicy);
    expect(second.implementerOptions).toHaveLength(1);
    expect(first.implementerOptions).toHaveLength(1);
    const normalImplementer = first.implementerOptions[0] as Record<string, unknown>;
    const discussImplementer = second.implementerOptions[0] as Record<string, unknown>;
    for (const key of [
      "executable",
      "gracefulShutdownMs",
      "terminateTimeoutMs",
      "forceKillTimeoutMs",
      "startupTimeoutMs",
      "promptTurnTimeoutMs",
      "explicitAllowInheritedMcp",
      "approvalMode",
      "autoPermissions",
    ]) {
      expect(discussImplementer[key], `implementer option ${key}`).toEqual(normalImplementer[key]);
    }
    const normalDiagnosis = first.diagnoseOptions[0] as Record<string, unknown>;
    const discussDiagnosis = second.diagnoseOptions[0] as Record<string, unknown>;
    expect(discussDiagnosis.inheritedMcpPolicy).toEqual(normalDiagnosis.inheritedMcpPolicy);
    expect(discussDiagnosis.nonInteractive).toEqual(normalDiagnosis.nonInteractive);
  });

  it.each([
    { label: "configured", implementer: "reviewer", cliImplementer: undefined },
    { label: "CLI override", implementer: "implementer", cliImplementer: "reviewer" },
  ])(
    "rejects same implementer and reviewer by default before agent startup ($label)",
    async ({ implementer, cliImplementer }) => {
      const agents = agentsResult({ implementer, reviewer: "reviewer" });
      let implementerConfigCalls = 0;
      const { options } = harness(agents, {
        ...(cliImplementer !== undefined ? { implementer: cliImplementer } : {}),
        loadImplementerConfig: async () => {
          implementerConfigCalls += 1;
          return { kind: "acp-server", profile: acpProfile("implementer"), snapshot: {} };
        },
      });

      const error = await createDiscussToPrDependencies(options as never).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(RoleAssignmentError);
      expect((error as RoleAssignmentError).code).toBe("same_implementer_reviewer");
      expect((error as RoleAssignmentError).nextAction).toContain("allowSameImplementerReviewer");
      expect(implementerConfigCalls).toBe(0);
    },
  );

  it("honors the explicit allowSameImplementerReviewer escape hatch", async () => {
    const agents = agentsResult({
      implementer: "reviewer",
      reviewer: "reviewer",
      allowSameImplementerReviewer: true,
    });
    const { options } = harness(agents, { useLocalFakes: true });
    const wiring = await createDiscussToPrDependencies(options as never);
    expect(wiring.deps.delivery).toBeDefined();
  });

  it("resolves an explicit specifier role after delivery roles", async () => {
    const agents = agentsResult({ specifier: "specifier" });
    const { options, roleAgentProfiles } = harness(agents);
    await createDiscussToPrDependencies(options as never);
    expect(roleAgentProfiles.at(-1)).toBe("specifier");
  });

  it("falls back to the planner when roles.specifier is absent", async () => {
    const agents = agentsResult({});
    const { options, roleAgentProfiles } = harness(agents);
    await createDiscussToPrDependencies(options as never);
    expect(roleAgentProfiles.at(-1)).toBe("planner");
  });

  it("fails closed with a clear error when the resolved specifier uses sdk transport", async () => {
    const sdkPlanner = sdkCodexProfile("planner");
    const agents = agentsResult({ planner: "planner", extraProfiles: [sdkPlanner] });
    let roleAgentCount = 0;
    const { options } = harness(agents, {
      createAcpRoleAgent: (input: { profile: AgentProfile }) => {
        roleAgentCount += 1;
        return unusedRoleAgent(input.profile.id);
      },
    });

    const error = await createDiscussToPrDependencies(options as never).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RoleAssignmentError);
    expect((error as RoleAssignmentError).code).toBe("transport_unsupported");
    expect((error as RoleAssignmentError).message).toContain("specifier");
    expect((error as RoleAssignmentError).nextAction).toContain("transport: acp");
    expect(roleAgentCount).toBeGreaterThan(0);
  });
});

describe("createDiscussToPrDependencies fake end-to-end wiring", () => {
  it("runs discussion, approval, specification, implementation and publish without real agents", async () => {
    const root = await tempRoot();
    const repositoryPath = path.join(root, "repo");
    const worktreePath = path.join(root, "worktree");
    const artifactRoot = path.join(root, "artifacts");
    await fs.mkdir(repositoryPath, { recursive: true });
    await fs.mkdir(worktreePath, { recursive: true });
    const agents = agentsResult({ implementer: undefined });
    const { options } = harness(agents, {
      useLocalFakes: true,
      repositoryPath,
      cwd: repositoryPath,
      runsRoot: path.join(root, "runs"),
    });
    const wiring = await createDiscussToPrDependencies(options as never);

    const input: RunDiscussToPrInput = {
      repository: "owner/repo",
      issueNumber: 22,
      repositoryPath,
      worktreePath,
      branch: "meguribi/issue-22",
      baseRef: "HEAD",
      requiredLabels: ["agent:ready"],
      repositoryRules: "Follow AGENTS.md",
      limits: { maxTurns: 8, maxDurationMs: 60_000, turnTimeoutMs: 1_000 },
      nonInteractive: true,
      artifactRoot,
      outOfScope: [],
      protectedPaths: [".env"],
      verifyCommands: [],
      inheritedMcpPolicy: wiring.inheritedMcpPolicy,
      allowInheritedMcp: false,
      maxFixAttempts: 1,
      artifactRootForDevin: artifactRoot,
    };
    const first = await runDiscussToPr(input, wiring.deps);
    expect(first.status).toBe("awaiting_human");

    await approveDiscussion(
      { runId: first.runId, approver: "wiring-test" },
      {
        runStore: wiring.deps.discussion.runStore,
        createStore: wiring.deps.discussion.createStore,
        hashConclusion: wiring.deps.discussion.hashConclusion,
        now: () => new Date(),
      },
    );
    const continued = await continueDiscussToPrAfterApproval({ runId: first.runId }, wiring.deps);

    expect(continued.published, `${continued.status}: ${continued.reasons.join(" | ")}`).toBe(true);
    const specification = await wiring.deps.discussion.runStore.readArtifact(
      first.runId,
      "specification.json",
    );
    expect(specification).not.toBeNull();
  });
});
