import type {
  AgentAdapter,
  AgentDiagnosis,
  DeliveryDependencies,
  IssueRecord,
  LiveLogEvent,
  PlanArtifact,
  ReviewArtifact,
  RoleAgent,
  VerificationResult,
} from "@meguribi/core";
import { RoleAssignmentError } from "@meguribi/core";
import {
  BUILTIN_AGENT_PROFILES,
  type CursorConfigResult,
  type DevinConfigResult,
} from "@meguribi/config";
import {
  MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
  MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
} from "@meguribi/adapters";
import { describe, expect, it } from "vitest";
import { createDeliveryDeps, createPlanDependencies } from "./create-delivery-deps.js";

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

function devinConfigResult(
  overrides: Partial<DevinConfigResult["config"]> = {},
): DevinConfigResult {
  return {
    config: {
      executable: "devin-custom",
      transport: "acp",
      gracefulShutdownMs: 2_000,
      terminateTimeoutMs: 3_000,
      forceKillTimeoutMs: 1_000,
      startupTimeoutMs: 6_000,
      turnTimeoutMinutes: 30,
      inheritedMcpPolicy: "allow",
      ...overrides,
    },
    snapshot: {},
  };
}

function cursorConfigResult(
  overrides: Partial<CursorConfigResult["config"]> = {},
): CursorConfigResult {
  return {
    config: {
      executable: "cursor-custom",
      transport: "acp",
      gracefulShutdownMs: 2_000,
      terminateTimeoutMs: 3_000,
      forceKillTimeoutMs: 1_000,
      startupTimeoutMs: 5_000,
      turnTimeoutMinutes: 20,
      inheritedMcpPolicy: "deny",
      ...overrides,
    },
    snapshot: {},
  };
}

function agentsResult(planner: string, reviewer: string) {
  return {
    profiles: BUILTIN_AGENT_PROFILES,
    roles: {
      discussants: [],
      planner,
      reviewer,
      allowSameImplementerReviewer: false,
    },
    snapshot: {},
  };
}

function planArtifact(summary: string): PlanArtifact {
  return {
    schemaVersion: 1,
    artifactType: "implementation-plan",
    summary,
    requirements: [],
    acceptanceCriteria: [],
    outOfScope: [],
    proposedFiles: [],
    steps: ["Implement"],
    risks: [],
    tests: [],
    humanDecisions: [],
    unresolvedItems: [],
    metadata: {
      schemaVersion: 1,
      artifactId: "plan-test",
      createdAt: "2026-07-29T00:00:00.000Z",
      durationMs: 1,
      producer: { kind: "codex", role: "planner", threadId: "plan-thread" },
      sourceDigests: {},
      eventLog: [],
    },
  };
}

function reviewArtifact(summary: string): ReviewArtifact {
  return {
    schemaVersion: 1,
    artifactType: "code-review",
    status: "approved",
    summary,
    requirementCoverage: [],
    findings: [],
    missingTests: [],
    scopeViolations: [],
    recommendedAction: "proceed",
    metadata: {
      schemaVersion: 1,
      artifactId: "review-test",
      createdAt: "2026-07-29T00:00:00.000Z",
      durationMs: 1,
      producer: { kind: "codex", role: "reviewer", threadId: "review-thread" },
      sourceDigests: {},
      eventLog: [],
    },
  };
}

const issue: IssueRecord = {
  number: 64,
  title: "Issue",
  body: "body",
  labels: [],
  comments: [],
  updatedAt: "2026-07-29T00:00:00.000Z",
};

const verification: VerificationResult = {
  schemaVersion: 1,
  artifactType: "verification",
  success: true,
  commands: [],
};

function unusedRoleAgent(profileId: string): RoleAgent {
  return {
    profileId,
    kind: "claude-code",
    async openSession() {
      throw new Error("unexpected role agent session");
    },
  };
}

describe("createPlanDependencies role wiring", () => {
  it("combines an ACP planner bridge with the Codex SDK reviewer bridge", async () => {
    const createdProfiles: string[] = [];
    let sawBridgeOptions: unknown;
    const acpBridge = {
      createPlan: async () => planArtifact("acp plan"),
      review: async () => reviewArtifact("unused acp review"),
    };
    const sdkBridge = {
      createPlan: async () => planArtifact("unused sdk plan"),
      review: async () => reviewArtifact("sdk review"),
    };

    const deps = await createPlanDependencies({
      cwd: "C:/fixture/repository",
      repositoryPath: "C:/fixture/repository",
      repository: "owner/repo",
      localOnly: true,
      loadAgentsConfig: async () => agentsResult("claude-code", "codex"),
      diagnoseAcpServer: async () => healthyAcpDiagnosis,
      createAcpRoleAgent: (options) => {
        createdProfiles.push(options.profile.id);
        return unusedRoleAgent(options.profile.id);
      },
      createRoleAgentPlanningBridge: (options) => {
        sawBridgeOptions = options;
        return acpBridge;
      },
      createCodexBridge: () => sdkBridge,
    });

    const codex = deps.codex as DeliveryDependencies["codex"];
    const plan = await codex.createPlan({
      repositoryPath: "C:/fixture/repository",
      issue,
      repositoryRules: "rules",
      completionCriteria: [],
      outOfScope: [],
    });
    const review = await codex.review({
      repositoryPath: "C:/fixture/repository",
      issue,
      plan,
      diff: "diff",
      changedFiles: ["src/file.ts"],
      verification,
      repositoryRules: "rules",
    });

    expect(createdProfiles).toEqual(["claude-code"]);
    expect(sawBridgeOptions).toMatchObject({ planner: { profileId: "claude-code" } });
    expect(plan.summary).toBe("acp plan");
    expect(review.summary).toBe("sdk review");
  });

  it("combines the Codex SDK planner bridge with an ACP reviewer bridge", async () => {
    const createdProfiles: string[] = [];
    let sawBridgeOptions: unknown;
    const acpBridge = {
      createPlan: async () => planArtifact("unused acp plan"),
      review: async () => reviewArtifact("acp review"),
    };
    const sdkBridge = {
      createPlan: async () => planArtifact("sdk plan"),
      review: async () => reviewArtifact("unused sdk review"),
    };

    const deps = await createPlanDependencies({
      cwd: "C:/fixture/repository",
      repositoryPath: "C:/fixture/repository",
      repository: "owner/repo",
      localOnly: true,
      loadAgentsConfig: async () => agentsResult("codex", "claude-code"),
      diagnoseAcpServer: async () => healthyAcpDiagnosis,
      createAcpRoleAgent: (options) => {
        createdProfiles.push(options.profile.id);
        return unusedRoleAgent(options.profile.id);
      },
      createRoleAgentPlanningBridge: (options) => {
        sawBridgeOptions = options;
        return acpBridge;
      },
      createCodexBridge: () => sdkBridge,
    });

    const codex = deps.codex as DeliveryDependencies["codex"];
    const plan = await codex.createPlan({
      repositoryPath: "C:/fixture/repository",
      issue,
      repositoryRules: "rules",
      completionCriteria: [],
      outOfScope: [],
    });
    const review = await codex.review({
      repositoryPath: "C:/fixture/repository",
      issue,
      plan,
      diff: "diff",
      changedFiles: ["src/file.ts"],
      verification,
      repositoryRules: "rules",
    });

    expect(createdProfiles).toEqual(["claude-code"]);
    expect(sawBridgeOptions).toMatchObject({ reviewer: { profileId: "claude-code" } });
    expect(plan.summary).toBe("sdk plan");
    expect(review.summary).toBe("acp review");
  });

  it("uses the Codex SDK bridge without ACP role agents when planner and reviewer are sdk codex", async () => {
    let acpRoleAgentCalls = 0;
    const sdkBridge = {
      createPlan: async () => planArtifact("sdk plan"),
      review: async () => reviewArtifact("sdk review"),
    };

    const deps = await createPlanDependencies({
      cwd: "C:/fixture/repository",
      repositoryPath: "C:/fixture/repository",
      repository: "owner/repo",
      localOnly: true,
      loadAgentsConfig: async () => agentsResult("codex", "codex"),
      createAcpRoleAgent: () => {
        acpRoleAgentCalls += 1;
        return unusedRoleAgent("unexpected");
      },
      createCodexBridge: () => sdkBridge,
    });

    const plan = await deps.codex.createPlan({
      repositoryPath: "C:/fixture/repository",
      issue,
      repositoryRules: "rules",
      completionCriteria: [],
      outOfScope: [],
    });

    expect(acpRoleAgentCalls).toBe(0);
    expect(plan.summary).toBe("sdk plan");
  });
});

describe("createDeliveryDeps ACP wiring", () => {
  it("wires a standalone ACP server implementer and reruns preflight through diagnoseAcpServer", async () => {
    const profile = BUILTIN_AGENT_PROFILES.find((candidate) => candidate.id === "claude-code");
    if (profile === undefined) throw new Error("claude-code profile missing");
    let diagnoses = 0;
    let sawImplementerOptions: unknown;
    const implementer: AgentAdapter = {
      implement: async () => {
        throw new Error("not used");
      },
      fix: async () => {
        throw new Error("not used");
      },
    };

    const wiring = await createDeliveryDeps({
      cwd: "C:/fixture/repository",
      repositoryPath: "C:/fixture/repository",
      useLocalFakes: true,
      loadImplementerConfig: async () => ({
        kind: "acp-server",
        profile,
        snapshot: {},
      }),
      diagnoseAcpServer: async () => {
        diagnoses += 1;
        return healthyAcpDiagnosis;
      },
      createAcpServerImplementer: (options) => {
        sawImplementerOptions = options;
        return implementer;
      },
    });

    expect(wiring.deps.implementer).toBe(implementer);
    expect(wiring.deps.implementerProfile).toEqual({ id: "claude-code", kind: "claude-code" });
    expect(sawImplementerOptions).toMatchObject({
      profile: { id: "claude-code" },
      executable: "claude-agent-acp",
    });
    await wiring.deps.assertImplementerReady?.();
    expect(diagnoses).toBe(2);
  });

  it("passes the injected agent observer to role planning and delivery dependencies", async () => {
    const profile = BUILTIN_AGENT_PROFILES.find((candidate) => candidate.id === "claude-code");
    if (profile === undefined) throw new Error("claude-code profile missing");
    let bridgeOnEvent: ((event: never) => void) | undefined;
    const implementer: AgentAdapter = {
      implement: async () => {
        throw new Error("not used");
      },
      fix: async () => {
        throw new Error("not used");
      },
    };
    const received: unknown[] = [];
    const observer = (event: LiveLogEvent) => {
      received.push(event);
    };

    const wiring = await createDeliveryDeps({
      cwd: "C:/fixture/repository",
      repositoryPath: "C:/fixture/repository",
      repository: "owner/repo",
      onAgentEvent: observer,
      loadImplementerConfig: async () => ({
        kind: "acp-server",
        profile,
        snapshot: {},
      }),
      diagnoseAcpServer: async () => healthyAcpDiagnosis,
      createAcpServerImplementer: () => implementer,
      loadAgentsConfig: async () => agentsResult("claude-code", "codex"),
      createAcpRoleAgent: (options) => unusedRoleAgent(options.profile.id),
      createRoleAgentPlanningBridge: (options) => {
        bridgeOnEvent = options.onEvent as ((event: never) => void) | undefined;
        return {
          createPlan: async () => planArtifact("acp plan"),
          review: async () => reviewArtifact("acp review"),
        };
      },
      createCodexBridge: () => ({
        createPlan: async () => planArtifact("sdk plan"),
        review: async () => reviewArtifact("sdk review"),
      }),
    });

    expect(wiring.deps.onAgentEvent).toBe(observer);
    bridgeOnEvent?.({
      type: "agent.event",
      stepId: "plan",
      profileId: "claude-code",
      agentLabel: "Claude Code",
      role: "planner",
      event: {
        type: "message.delta",
        sessionId: "session-1",
        text: "thinking",
        at: "2026-07-29T00:00:00.000Z",
      },
    } as never);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ stepId: "plan", role: "planner" });
  });

  it("fails closed for a non-Codex sdk planner instead of wiring it as ACP", async () => {
    const unsupported = {
      id: "claude-sdk",
      kind: "claude-code" as const,
      transport: "sdk" as const,
      startupTimeoutMs: 1000,
      turnTimeoutMinutes: 1,
      inheritedMcpPolicy: "allow" as const,
    };

    await expect(
      createPlanDependencies({
        cwd: "C:/fixture/repository",
        repositoryPath: "C:/fixture/repository",
        repository: "owner/repo",
        loadAgentsConfig: async () => ({
          profiles: [...BUILTIN_AGENT_PROFILES, unsupported],
          roles: {
            discussants: [],
            planner: "claude-sdk",
            reviewer: "codex",
            allowSameImplementerReviewer: false,
          },
          snapshot: {},
        }),
      }),
    ).rejects.toMatchObject({
      name: "RoleAssignmentError",
      code: "transport_unsupported",
    });
  });
});

describe("Devin/Cursor planning role wiring", () => {
  const acpBridge = {
    createPlan: async () => planArtifact("unused acp plan"),
    review: async () => reviewArtifact("unused acp review"),
  };
  const sdkBridge = {
    createPlan: async () => planArtifact("unused sdk plan"),
    review: async () => reviewArtifact("unused sdk review"),
  };

  it("wires a devin planner through diagnoseDevin with the acp subcommand", async () => {
    let diagnoseDevinOptions: unknown;
    let diagnoseCursorCalls = 0;
    let diagnoseAcpServerCalls = 0;
    let sawRoleAgentOptions: unknown;

    await createPlanDependencies({
      cwd: "C:/fixture/repository",
      repositoryPath: "C:/fixture/repository",
      repository: "owner/repo",
      localOnly: true,
      loadAgentsConfig: async () => agentsResult("devin", "codex"),
      loadDevinConfig: async () => devinConfigResult(),
      diagnoseDevin: async (options) => {
        diagnoseDevinOptions = options;
        return {
          ...healthyAcpDiagnosis,
          executable: { status: "ok", path: "devin-custom" },
          inheritedMcpPolicy: "allow",
        };
      },
      diagnoseCursor: async () => {
        diagnoseCursorCalls += 1;
        return healthyAcpDiagnosis;
      },
      diagnoseAcpServer: async () => {
        diagnoseAcpServerCalls += 1;
        return healthyAcpDiagnosis;
      },
      createAcpRoleAgent: (options) => {
        sawRoleAgentOptions = options;
        return unusedRoleAgent(options.profile.id);
      },
      createRoleAgentPlanningBridge: () => acpBridge,
      createCodexBridge: () => sdkBridge,
    });

    expect(diagnoseDevinOptions).toMatchObject({
      executable: "devin-custom",
      inheritedMcpPolicy: "allow",
      nonInteractive: false,
      cwd: "C:/fixture/repository",
      probeTimeoutMs: 6_000,
      minimumSupportedVersion: MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
    });
    expect(sawRoleAgentOptions).toMatchObject({
      profile: { id: "devin", kind: "devin" },
      executable: "devin-custom",
      acpArgs: ["acp"],
      diagnosis: {
        executable: { status: "ok", path: "devin-custom" },
        inheritedMcpPolicy: "allow",
      },
      mode: "interactive",
    });
    expect(diagnoseCursorCalls).toBe(0);
    expect(diagnoseAcpServerCalls).toBe(0);
  });

  it("wires a cursor reviewer through diagnoseCursor with the resolved executable and acp subcommand", async () => {
    let diagnoseCursorOptions: unknown;
    let diagnoseDevinCalls = 0;
    let diagnoseAcpServerCalls = 0;
    let sawRoleAgentOptions: unknown;

    await createPlanDependencies({
      cwd: "C:/fixture/repository",
      repositoryPath: "C:/fixture/repository",
      repository: "owner/repo",
      localOnly: true,
      loadAgentsConfig: async () => agentsResult("codex", "cursor"),
      loadCursorConfig: async () => cursorConfigResult(),
      diagnoseDevin: async () => {
        diagnoseDevinCalls += 1;
        return healthyAcpDiagnosis;
      },
      diagnoseCursor: async (options) => {
        diagnoseCursorOptions = options;
        return {
          ...healthyAcpDiagnosis,
          executable: { status: "ok", path: "/resolved/cursor-agent" },
          inheritedMcpPolicy: "deny",
        };
      },
      diagnoseAcpServer: async () => {
        diagnoseAcpServerCalls += 1;
        return healthyAcpDiagnosis;
      },
      createAcpRoleAgent: (options) => {
        sawRoleAgentOptions = options;
        return unusedRoleAgent(options.profile.id);
      },
      createRoleAgentPlanningBridge: () => acpBridge,
      createCodexBridge: () => sdkBridge,
    });

    expect(diagnoseCursorOptions).toMatchObject({
      executable: "cursor-custom",
      inheritedMcpPolicy: "deny",
      nonInteractive: false,
      cwd: "C:/fixture/repository",
      probeTimeoutMs: 5_000,
      minimumSupportedVersion: MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
    });
    expect(sawRoleAgentOptions).toMatchObject({
      profile: { id: "cursor", kind: "cursor" },
      executable: "/resolved/cursor-agent",
      acpArgs: ["acp"],
      diagnosis: {
        executable: { status: "ok", path: "/resolved/cursor-agent" },
        inheritedMcpPolicy: "deny",
      },
      mode: "interactive",
    });
    expect(diagnoseDevinCalls).toBe(0);
    expect(diagnoseAcpServerCalls).toBe(0);
  });

  it("wires a devin planner in createDeliveryDeps with non-interactive diagnostics", async () => {
    let diagnoseDevinOptions: unknown;
    let diagnoseAcpServerCalls = 0;
    let sawRoleAgentOptions: unknown;

    await createDeliveryDeps({
      cwd: "C:/fixture/repository",
      repositoryPath: "C:/fixture/repository",
      repository: "owner/repo",
      localOnly: true,
      nonInteractive: true,
      loadImplementerConfig: async () => ({ kind: "cursor", ...cursorConfigResult() }),
      loadAgentsConfig: async () => agentsResult("devin", "codex"),
      loadDevinConfig: async () => devinConfigResult(),
      diagnoseDevin: async (options) => {
        diagnoseDevinOptions = options;
        return {
          ...healthyAcpDiagnosis,
          executable: { status: "ok", path: "devin-custom" },
          inheritedMcpPolicy: "allow",
        };
      },
      diagnoseCursor: async () => healthyAcpDiagnosis,
      diagnoseAcpServer: async () => {
        diagnoseAcpServerCalls += 1;
        return healthyAcpDiagnosis;
      },
      createAcpRoleAgent: (options) => {
        sawRoleAgentOptions = options;
        return unusedRoleAgent(options.profile.id);
      },
      createRoleAgentPlanningBridge: () => acpBridge,
      createCodexBridge: () => sdkBridge,
    });

    expect(diagnoseDevinOptions).toMatchObject({
      executable: "devin-custom",
      inheritedMcpPolicy: "allow",
      nonInteractive: true,
      cwd: "C:/fixture/repository",
      probeTimeoutMs: 6_000,
      minimumSupportedVersion: MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
    });
    expect(sawRoleAgentOptions).toMatchObject({
      profile: { id: "devin", kind: "devin" },
      executable: "devin-custom",
      acpArgs: ["acp"],
      mode: "non-interactive",
    });
    expect(diagnoseAcpServerCalls).toBe(0);
  });

  it("wires a cursor reviewer in createDeliveryDeps with non-interactive diagnostics", async () => {
    let diagnoseCursorOptions: unknown;
    let diagnoseAcpServerCalls = 0;
    let sawRoleAgentOptions: unknown;

    await createDeliveryDeps({
      cwd: "C:/fixture/repository",
      repositoryPath: "C:/fixture/repository",
      repository: "owner/repo",
      localOnly: true,
      nonInteractive: true,
      loadImplementerConfig: async () => ({ kind: "devin", ...devinConfigResult() }),
      loadAgentsConfig: async () => agentsResult("codex", "cursor"),
      loadCursorConfig: async () => cursorConfigResult(),
      diagnoseDevin: async () => healthyAcpDiagnosis,
      diagnoseCursor: async (options) => {
        diagnoseCursorOptions = options;
        return {
          ...healthyAcpDiagnosis,
          executable: { status: "ok", path: "/resolved/cursor-agent" },
          inheritedMcpPolicy: "deny",
        };
      },
      diagnoseAcpServer: async () => {
        diagnoseAcpServerCalls += 1;
        return healthyAcpDiagnosis;
      },
      createAcpRoleAgent: (options) => {
        sawRoleAgentOptions = options;
        return unusedRoleAgent(options.profile.id);
      },
      createRoleAgentPlanningBridge: () => acpBridge,
      createCodexBridge: () => sdkBridge,
    });

    expect(diagnoseCursorOptions).toMatchObject({
      executable: "cursor-custom",
      inheritedMcpPolicy: "deny",
      nonInteractive: true,
      cwd: "C:/fixture/repository",
      probeTimeoutMs: 5_000,
      minimumSupportedVersion: MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
    });
    expect(sawRoleAgentOptions).toMatchObject({
      profile: { id: "cursor", kind: "cursor" },
      executable: "/resolved/cursor-agent",
      acpArgs: ["acp"],
      mode: "non-interactive",
    });
    expect(diagnoseAcpServerCalls).toBe(0);
  });
});

describe("createDeliveryDeps role validation", () => {
  it("propagates same_implementer_reviewer as a RoleAssignmentError with nextAction", async () => {
    await expect(
      createDeliveryDeps({
        cwd: "C:/fixture/repository",
        repositoryPath: "C:/fixture/repository",
        loadImplementerConfig: async () => {
          throw new RoleAssignmentError(
            "same_implementer_reviewer",
            "implementer and reviewer must differ: claude-code",
            "`allowSameImplementerReviewer: true` を明示してください",
          );
        },
      }),
    ).rejects.toMatchObject({
      name: "RoleAssignmentError",
      code: "same_implementer_reviewer",
      nextAction: "`allowSameImplementerReviewer: true` を明示してください",
    });
  });
});
