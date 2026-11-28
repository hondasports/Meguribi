import type {
  AgentAdapter,
  AgentProfile,
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
import {
  createDeliveryDeps,
  createDiscussionDependencies,
  createPlanDependencies,
} from "./create-delivery-deps.js";

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

function discussionProfile(id: string, transport: "acp" | "sdk" = "acp"): AgentProfile {
  return {
    id,
    kind: id === "codex-sdk" ? "codex" : "claude-code",
    transport,
    executable: id,
    startupTimeoutMs: 1_000,
    turnTimeoutMinutes: 5,
    inheritedMcpPolicy: "allow",
  };
}

function discussionAgentsResult(
  discussants: readonly string[],
  options: { summarizer?: string; transport?: "acp" | "sdk" } = {},
) {
  const ids = [...new Set([...discussants, ...(options.summarizer ? [options.summarizer] : [])])];
  return {
    profiles: ids.map((id) =>
      discussionProfile(id, id === "codex-sdk" ? "sdk" : (options.transport ?? "acp")),
    ),
    roles: {
      discussants: [...discussants],
      ...(options.summarizer === undefined ? {} : { summarizer: options.summarizer }),
      planner: "codex",
      reviewer: "codex",
      allowSameImplementerReviewer: false,
    },
    snapshot: {},
  };
}

describe("createDiscussionDependencies", () => {
  function baseOptions(agentsResult: unknown) {
    return {
      cwd: "C:/fixture/repository",
      repositoryPath: "C:/fixture/repository",
      repository: "owner/repo",
      localOnly: true,
      loadAgentsConfig: async () => agentsResult as never,
      diagnoseAcpServer: async () => healthyAcpDiagnosis,
      createAcpRoleAgent: (options: { profile: AgentProfile }) =>
        unusedRoleAgent(options.profile.id),
    };
  }

  it("builds discussants and defaults the summarizer to the first discussant", async () => {
    const created: string[] = [];
    const deps = await createDiscussionDependencies({
      ...baseOptions(discussionAgentsResult(["alpha", "beta"])),
      createAcpRoleAgent: (options: { profile: AgentProfile }) => {
        created.push(options.profile.id);
        return unusedRoleAgent(options.profile.id);
      },
    } as never);

    expect(deps.discussants.map((agent) => agent.profileId)).toEqual(["alpha", "beta"]);
    expect(deps.summarizer.profileId).toBe("alpha");
    // summarizer は先頭 discussant と同じプロファイルなら使い回す。
    expect(created).toEqual(["alpha", "beta"]);
    expect(typeof deps.createStore).toBe("function");
    expect(typeof deps.parseEnvelope).toBe("function");
    expect(typeof deps.hashConclusion).toBe("function");
  });

  it("uses roles.summarizer when specified", async () => {
    const deps = await createDiscussionDependencies(
      baseOptions(discussionAgentsResult(["alpha", "beta"], { summarizer: "gamma" })) as never,
    );

    expect(deps.summarizer.profileId).toBe("gamma");
  });

  it.each([
    { discussants: ["alpha"], label: "fewer than 2" },
    { discussants: ["a", "b", "c", "d", "e"], label: "more than 4" },
  ])("throws invalid_discussants for $label discussants", async ({ discussants }) => {
    const error = await createDiscussionDependencies(
      baseOptions(discussionAgentsResult(discussants)) as never,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RoleAssignmentError);
    expect((error as RoleAssignmentError).code).toBe("invalid_discussants");
    expect((error as RoleAssignmentError).nextAction).toContain("roles.discussants");
  });

  function mcpDiscussionAgentsResult(input: {
    devinProfilePolicy?: "warn" | "allow" | "deny";
    cursorProfilePolicy?: "warn" | "allow" | "deny";
  } = {}) {
    const alpha = { ...discussionProfile("alpha"), inheritedMcpPolicy: "warn" as const };
    const beta = { ...discussionProfile("beta"), inheritedMcpPolicy: "allow" as const };
    const devin = {
      id: "devin",
      kind: "devin" as const,
      transport: "acp" as const,
      executable: "devin",
      startupTimeoutMs: 1_000,
      turnTimeoutMinutes: 5,
      inheritedMcpPolicy: input.devinProfilePolicy ?? ("warn" as const),
    };
    const cursor = {
      id: "cursor",
      kind: "cursor" as const,
      transport: "acp" as const,
      executable: "cursor",
      startupTimeoutMs: 1_000,
      turnTimeoutMinutes: 5,
      inheritedMcpPolicy: input.cursorProfilePolicy ?? ("allow" as const),
    };
    return {
      profiles: [alpha, beta, devin, cursor],
      roles: {
        discussants: ["alpha", "beta", "devin"],
        summarizer: "cursor",
        planner: "codex",
        reviewer: "codex",
        allowSameImplementerReviewer: false,
      },
      snapshot: {},
    };
  }

  function mcpWiringHarness(input: {
    discussionMcpPolicy?: "allow" | "deny";
    devinConfigPolicy?: "warn" | "allow" | "deny";
    cursorConfigPolicy?: "warn" | "allow" | "deny";
    devinProfilePolicy?: "warn" | "allow" | "deny";
    cursorProfilePolicy?: "warn" | "allow" | "deny";
  }) {
    const loadDevinOptions: unknown[] = [];
    const loadCursorOptions: unknown[] = [];
    const acpDiagnosisProfiles: unknown[] = [];
    const devinDiagnosisOptions: unknown[] = [];
    const cursorDiagnosisOptions: unknown[] = [];
    const roleAgentOptions: unknown[] = [];

    const options = {
      cwd: "C:/fixture/repository",
      repositoryPath: "C:/fixture/repository",
      repository: "owner/repo",
      localOnly: true,
      nonInteractive: true,
      ...(input.discussionMcpPolicy === undefined
        ? {}
        : { discussionMcpPolicy: input.discussionMcpPolicy }),
      loadAgentsConfig: async () => mcpDiscussionAgentsResult({
        ...(input.devinProfilePolicy === undefined ? {} : { devinProfilePolicy: input.devinProfilePolicy }),
        ...(input.cursorProfilePolicy === undefined ? {} : { cursorProfilePolicy: input.cursorProfilePolicy }),
      }) as never,
      loadDevinConfig: async (loadOptions: unknown) => {
        loadDevinOptions.push(loadOptions);
        return devinConfigResult({ inheritedMcpPolicy: input.devinConfigPolicy ?? "warn" });
      },
      loadCursorConfig: async (loadOptions: unknown) => {
        loadCursorOptions.push(loadOptions);
        return cursorConfigResult({ inheritedMcpPolicy: input.cursorConfigPolicy ?? "allow" });
      },
      diagnoseAcpServer: async (diagnoseOptions: { profile: AgentProfile }) => {
        acpDiagnosisProfiles.push(diagnoseOptions.profile);
        return healthyAcpDiagnosis;
      },
      diagnoseDevin: async (diagnoseOptions: { inheritedMcpPolicy: "warn" | "allow" | "deny" }) => {
        devinDiagnosisOptions.push(diagnoseOptions);
        return {
          ...healthyAcpDiagnosis,
          executable: { status: "ok" as const, path: "devin-custom" },
          inheritedMcpPolicy: diagnoseOptions.inheritedMcpPolicy,
        };
      },
      diagnoseCursor: async (diagnoseOptions: { inheritedMcpPolicy: "warn" | "allow" | "deny" }) => {
        cursorDiagnosisOptions.push(diagnoseOptions);
        return {
          ...healthyAcpDiagnosis,
          executable: { status: "ok" as const, path: "cursor-custom" },
          inheritedMcpPolicy: diagnoseOptions.inheritedMcpPolicy,
        };
      },
      createAcpRoleAgent: (roleOptions: { profile: AgentProfile }) => {
        roleAgentOptions.push(roleOptions);
        return unusedRoleAgent(roleOptions.profile.id);
      },
    };

    return {
      options,
      loadDevinOptions,
      loadCursorOptions,
      acpDiagnosisProfiles,
      devinDiagnosisOptions,
      cursorDiagnosisOptions,
      roleAgentOptions,
    };
  }

  it("propagates an explicit allow to config loading, diagnosis, and every discussant plus the summarizer", async () => {
    const harness = mcpWiringHarness({ discussionMcpPolicy: "allow" });

    await createDiscussionDependencies(harness.options as never);

    expect(harness.loadDevinOptions[0]).toMatchObject({
      nonInteractive: true,
      discussionMcpPolicy: "allow",
    });
    expect(harness.loadCursorOptions[0]).toMatchObject({
      nonInteractive: true,
      discussionMcpPolicy: "allow",
    });
    expect(harness.devinDiagnosisOptions[0]).toMatchObject({ inheritedMcpPolicy: "allow" });
    expect(harness.cursorDiagnosisOptions[0]).toMatchObject({ inheritedMcpPolicy: "allow" });
    expect(harness.acpDiagnosisProfiles).toHaveLength(2);
    for (const profile of harness.acpDiagnosisProfiles) {
      expect(profile).toMatchObject({ inheritedMcpPolicy: "allow" });
    }
    expect(harness.roleAgentOptions.map((options) => (options as { profile: AgentProfile }).profile.id)).toEqual([
      "alpha",
      "beta",
      "devin",
      "cursor",
    ]);
    for (const options of harness.roleAgentOptions) {
      expect(options).toMatchObject({
        discussionMcpPolicy: "allow",
        profile: { inheritedMcpPolicy: "allow" },
      });
    }
  });

  it("makes an explicit run-scoped deny win over allow configuration for every discussion role", async () => {
    const harness = mcpWiringHarness({
      discussionMcpPolicy: "deny",
      devinConfigPolicy: "allow",
      cursorConfigPolicy: "allow",
    });

    await createDiscussionDependencies(harness.options as never);

    expect(harness.devinDiagnosisOptions[0]).toMatchObject({ inheritedMcpPolicy: "deny" });
    expect(harness.cursorDiagnosisOptions[0]).toMatchObject({ inheritedMcpPolicy: "deny" });
    for (const profile of harness.acpDiagnosisProfiles) {
      expect(profile).toMatchObject({ inheritedMcpPolicy: "deny" });
    }
    for (const options of harness.roleAgentOptions) {
      expect(options).toMatchObject({
        discussionMcpPolicy: "deny",
        profile: { inheritedMcpPolicy: "deny" },
      });
    }
  });

  it("keeps an explicitly configured deny dominant when the run selects allow", async () => {
    const harness = mcpWiringHarness({
      discussionMcpPolicy: "allow",
      devinConfigPolicy: "deny",
      cursorConfigPolicy: "allow",
    });

    await createDiscussionDependencies(harness.options as never);

    expect(harness.devinDiagnosisOptions[0]).toMatchObject({ inheritedMcpPolicy: "deny" });
    expect(harness.cursorDiagnosisOptions[0]).toMatchObject({ inheritedMcpPolicy: "allow" });
    const byProfile = new Map(
      harness.roleAgentOptions.map((options) => [
        (options as { profile: AgentProfile }).profile.id,
        options,
      ]),
    );
    expect(byProfile.get("devin")).toMatchObject({ profile: { inheritedMcpPolicy: "deny" } });
    expect(byProfile.get("alpha")).toMatchObject({ profile: { inheritedMcpPolicy: "allow" } });
    expect(byProfile.get("cursor")).toMatchObject({ profile: { inheritedMcpPolicy: "allow" } });
  });

  it("keeps a profile-level deny dominant for Devin even when config and the run select allow", async () => {
    const harness = mcpWiringHarness({
      discussionMcpPolicy: "allow",
      devinConfigPolicy: "allow",
      devinProfilePolicy: "deny",
    });

    await createDiscussionDependencies(harness.options as never);

    expect(harness.devinDiagnosisOptions[0]).toMatchObject({ inheritedMcpPolicy: "deny" });
    const byProfile = new Map(
      harness.roleAgentOptions.map((options) => [
        (options as { profile: AgentProfile }).profile.id,
        options,
      ]),
    );
    expect(byProfile.get("devin")).toMatchObject({
      discussionMcpPolicy: "allow",
      profile: { inheritedMcpPolicy: "deny" },
    });
    expect(byProfile.get("cursor")).toMatchObject({ profile: { inheritedMcpPolicy: "allow" } });
  });

  it("leaves the legacy profile and Devin/Cursor config contract unchanged when no run policy is selected", async () => {
    const harness = mcpWiringHarness({ devinConfigPolicy: "allow", cursorConfigPolicy: "deny" });

    await createDiscussionDependencies(harness.options as never);

    expect(harness.loadDevinOptions[0]).not.toHaveProperty("discussionMcpPolicy");
    expect(harness.loadCursorOptions[0]).not.toHaveProperty("discussionMcpPolicy");
    expect(harness.devinDiagnosisOptions[0]).toMatchObject({ inheritedMcpPolicy: "allow" });
    expect(harness.cursorDiagnosisOptions[0]).toMatchObject({ inheritedMcpPolicy: "deny" });
    expect(harness.acpDiagnosisProfiles[0]).toMatchObject({ inheritedMcpPolicy: "warn" });
    for (const options of harness.roleAgentOptions) {
      expect(options).not.toHaveProperty("discussionMcpPolicy");
    }
    const byProfile = new Map(
      harness.roleAgentOptions.map((options) => [
        (options as { profile: AgentProfile }).profile.id,
        options,
      ]),
    );
    expect(byProfile.get("alpha")).toMatchObject({ profile: { inheritedMcpPolicy: "warn" } });
    expect(byProfile.get("devin")).toMatchObject({ profile: { inheritedMcpPolicy: "warn" } });
    expect(byProfile.get("cursor")).toMatchObject({ profile: { inheritedMcpPolicy: "allow" } });
  });

  it("throws transport_unsupported for an sdk discussant", async () => {
    const error = await createDiscussionDependencies(
      baseOptions(discussionAgentsResult(["alpha", "codex-sdk"])) as never,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RoleAssignmentError);
    expect((error as RoleAssignmentError).code).toBe("transport_unsupported");
    expect((error as RoleAssignmentError).nextAction).toContain("transport: acp");
  });
});
