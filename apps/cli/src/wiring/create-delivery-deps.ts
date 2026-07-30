import { homedir } from "node:os";
import path from "node:path";
import {
  createCodexAdapter,
  captureGitWorktreeSnapshot,
  createCommandVerifier,
  createCursorAcpAdapter,
  createDefaultPolicyEngine,
  createDevinAcpAdapter,
  createFakeCodexForDelivery,
  createFakeGitAdapter,
  createFakeGitHubAdapter,
  createFakeVerifier,
  createGitAdapter,
  createGitHubAdapter,
  createLocalGitHubAdapter,
  CodexSdkClient,
  digestSource,
  diagnoseCursor,
  diagnoseDevin,
  FileSystemRunStore,
  FileSystemPlanArtifactStore,
  FileSystemDiscoveryArtifactStore,
  FileSystemHypothesisArtifactStore,
  FileSystemProblemArtifactStore,
  FileSystemExploreArtifactStore,
  FileSystemRequirementArtifactStore,
  FileSystemMeasurementArtifactStore,
  MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
  MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
  preflightCursor,
  preflightDevin,
} from "@meguribi/adapters";
import { loadImplementerConfig } from "@meguribi/config";
import type {
  CleanupDependencies,
  DiscoverDependencies,
  HypothesisDependencies,
  PromoteDependencies,
  ExploreDependencies,
  RequireDependencies,
  MeasureDependencies,
  DeliveryDependencies,
  InheritedMcpPolicy,
  PlanDependencies,
  ReviewDependencies,
} from "@meguribi/core";
import type { CodexClient, CodexWorkspaceGuard } from "@meguribi/adapters";

export interface CreateDeliveryDepsOptions {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  nonInteractive?: boolean;
  implementer?: string;
  allowInheritedMcp?: boolean;
  /**
   * Prefer local fakes for GitHub/Git/Codex/Verifier.
   * Devin ACP facade and FileSystemRunStore stay real so ACP implement works.
   * Also enabled when MEGURIBI_DELIVERY_FAKES=1.
   */
  useLocalFakes?: boolean;
  runsRoot?: string;
}

export interface CreatePlanDepsOptions {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  useLocalFakes?: boolean;
  runsRoot?: string;
}

export interface CreateReviewDepsOptions {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  useLocalFakes?: boolean;
  runsRoot?: string;
}

export interface CreateCleanupDepsOptions {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  useLocalFakes?: boolean;
  runsRoot?: string;
}

export interface CreateDiscoverDepsOptions {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  useLocalFakes?: boolean;
  runsRoot?: string;
}

export interface CreateHypothesisDepsOptions {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  useLocalFakes?: boolean;
  runsRoot?: string;
}

export interface CreatePromoteDepsOptions {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  useLocalFakes?: boolean;
  runsRoot?: string;
}

export interface CreateExploreDepsOptions { cwd?: string; repositoryPath?: string; repository?: string; localOnly?: boolean; useLocalFakes?: boolean; runsRoot?: string }
export interface CreateRequireDepsOptions { cwd?: string; repositoryPath?: string; repository?: string; localOnly?: boolean; useLocalFakes?: boolean; runsRoot?: string }
export interface CreateMeasureDepsOptions { cwd?: string; repositoryPath?: string; repository?: string; localOnly?: boolean; useLocalFakes?: boolean; runsRoot?: string }

function resolveRunsRoot(explicit?: string): string {
  if (explicit) {
    return explicit;
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "meguribi");
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
    return path.join(local, "meguribi");
  }
  return path.join(homedir(), ".local", "share", "meguribi");
}

export interface CodexBridgeOptions {
  client?: CodexClient;
  workspaceSnapshot?: (repositoryPath: string) => Promise<string>;
}

async function captureWorkspaceSnapshot(repositoryPath: string): Promise<string> {
  return JSON.stringify(await captureGitWorktreeSnapshot({ cwd: repositoryPath }));
}

function issueContext(issue: Parameters<DeliveryDependencies["codex"]["createPlan"]>[0]["issue"]) {
  return {
    title: issue.title,
    body: issue.body,
    comments: issue.comments.map((comment) => comment.body),
  };
}

async function createWorkspaceGuard(
  repositoryPath: string,
  workspaceSnapshot: (repositoryPath: string) => Promise<string>,
): Promise<{ guard: CodexWorkspaceGuard; sourceDigest: string }> {
  const guard: CodexWorkspaceGuard = {
    snapshot: () => workspaceSnapshot(repositoryPath),
  };
  const before = await guard.snapshot();
  return { guard, sourceDigest: digestSource(before) };
}

export function createCodexBridge(
  options: CodexBridgeOptions = {},
): DeliveryDependencies["codex"] {
  const adapter = createCodexAdapter({ client: options.client ?? new CodexSdkClient() });
  const workspaceSnapshot = options.workspaceSnapshot ?? captureWorkspaceSnapshot;
  return {
    createPlan: async (input) => {
      const issue = issueContext(input.issue);
      const workspace = await createWorkspaceGuard(input.repositoryPath, workspaceSnapshot);
      return adapter.createPlan({
        repositoryPath: input.repositoryPath,
        issue,
        repositoryRules: input.repositoryRules,
        completionCriteria: input.completionCriteria,
        outOfScope: input.outOfScope,
        sourceDigests: {
          issue: digestSource(issue),
          repository: workspace.sourceDigest,
        },
        workspaceGuard: workspace.guard,
      });
    },
    review: async (input) => {
      const issue = issueContext(input.issue);
      const workspace = await createWorkspaceGuard(input.repositoryPath, workspaceSnapshot);
      const verification = {
        success: input.verification.success,
        commands: input.verification.commands.map((command) => ({
          name: command.name,
          exitCode: command.exitCode,
        })),
      };
      return adapter.review({
        repositoryPath: input.repositoryPath,
        issue,
        plan: input.plan,
        diff: input.diff,
        changedFiles: input.changedFiles,
        verification,
        repositoryRules: input.repositoryRules,
        sourceDigests: {
          issue: digestSource(issue),
          plan: digestSource(input.plan),
          diff: digestSource(input.diff),
          verification: digestSource(verification),
          repository: workspace.sourceDigest,
        },
        workspaceGuard: workspace.guard,
      });
    },
  };
}

/**
 * Default delivery wiring for `meguribi run` / `resume`.
 * Real: GitHub/Git/Codex/Verifier, selected AgentAdapter, FileSystemRunStore, PolicyEngine.
 * Fakes are opt-in for fixture tests through MEGURIBI_DELIVERY_FAKES=1.
 */
export async function createDeliveryDeps(
  options: CreateDeliveryDepsOptions = {},
): Promise<{ deps: DeliveryDependencies; inheritedMcpPolicy: InheritedMcpPolicy }> {
  const cwd = options.cwd ?? process.cwd();
  const nonInteractive = options.nonInteractive ?? false;
  const allowInheritedMcp = options.allowInheritedMcp ?? false;
  const useLocalFakes =
    options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";

  const config = await loadImplementerConfig({
    repositoryPath: cwd,
    nonInteractive,
    cli: {
      ...(options.implementer !== undefined ? { implementer: options.implementer } : {}),
      // The explicit run flag must win over repository config so that a
      // non-interactive local run can proceed when the repository still uses
      // the interactive default (`warn`).
      ...(allowInheritedMcp ? { inheritedMcpPolicy: "allow" } : {}),
    },
  });

  if (config.kind === "cursor") {
    const inheritedMcpPolicy = config.config.inheritedMcpPolicy;
    const diagnosis = await diagnoseCursor({
      executable: config.config.executable,
      inheritedMcpPolicy,
      nonInteractive,
      cwd,
      probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
      minimumSupportedVersion: MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
    });
    const resolvedExecutable = diagnosis.executable.path ?? config.config.executable;
    let currentDiagnosis = diagnosis;

    const implementer = createCursorAcpAdapter({
      executable: resolvedExecutable,
      diagnosis,
      getDiagnosis: () => currentDiagnosis,
      inheritedMcpPolicy,
      mode: nonInteractive ? "non-interactive" : "interactive",
      explicitAllowInheritedMcp: allowInheritedMcp,
      startupTimeoutMs: config.config.startupTimeoutMs,
      promptTimeoutMs: config.config.turnTimeoutMinutes * 60_000,
    });

    return {
      inheritedMcpPolicy,
      deps: {
        github: useLocalFakes
          ? createFakeGitHubAdapter()
          : options.localOnly
            ? createLocalGitHubAdapter({ cwd: options.repositoryPath ?? cwd })
            : createGitHubAdapter({ cwd, executable: "gh" }),
        git: useLocalFakes ? createFakeGitAdapter() : createGitAdapter({ expectedRepository: options.repository, allowMissingRemote: options.localOnly }),
        codex: useLocalFakes ? createFakeCodexForDelivery() : createCodexBridge(),
        implementer,
        devin: implementer,
        verifier: useLocalFakes ? createFakeVerifier() : createCommandVerifier(),
        policy: createDefaultPolicyEngine(),
        runStore: new FileSystemRunStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
        async assertImplementerReady() {
          currentDiagnosis = await preflightCursor({
            executable: resolvedExecutable,
            inheritedMcpPolicy,
            nonInteractive,
            cwd,
            probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
            minimumSupportedVersion: MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
          });
        },
        async assertDevinReady() {
          currentDiagnosis = await preflightCursor({
            executable: resolvedExecutable,
            inheritedMcpPolicy,
            nonInteractive,
            cwd,
            probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
            minimumSupportedVersion: MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
          });
        },
      },
    };
  }

  const inheritedMcpPolicy = config.config.inheritedMcpPolicy;
  const diagnosis = await diagnoseDevin({
    executable: config.config.executable,
    inheritedMcpPolicy,
    nonInteractive,
    cwd,
    probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
    minimumSupportedVersion: MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
  });
  let currentDiagnosis = diagnosis;

  const implementer = createDevinAcpAdapter({
    executable: config.config.executable,
    diagnosis,
    getDiagnosis: () => currentDiagnosis,
    inheritedMcpPolicy,
    mode: nonInteractive ? "non-interactive" : "interactive",
    explicitAllowInheritedMcp: allowInheritedMcp,
    startupTimeoutMs: config.config.startupTimeoutMs,
    promptTimeoutMs: config.config.turnTimeoutMinutes * 60_000,
  });

  return {
    inheritedMcpPolicy,
    deps: {
      github: useLocalFakes
        ? createFakeGitHubAdapter()
        : options.localOnly
          ? createLocalGitHubAdapter({ cwd: options.repositoryPath ?? cwd })
          : createGitHubAdapter({ cwd, executable: "gh" }),
      git: useLocalFakes ? createFakeGitAdapter() : createGitAdapter({ expectedRepository: options.repository, allowMissingRemote: options.localOnly }),
      codex: useLocalFakes ? createFakeCodexForDelivery() : createCodexBridge(),
      implementer,
      devin: implementer,
      verifier: useLocalFakes ? createFakeVerifier() : createCommandVerifier(),
      policy: createDefaultPolicyEngine(),
      runStore: new FileSystemRunStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
      async assertImplementerReady() {
        currentDiagnosis = await preflightDevin({
          executable: config.config.executable,
          inheritedMcpPolicy,
          nonInteractive,
          cwd,
          probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
          minimumSupportedVersion: MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
        });
      },
      async assertDevinReady() {
        currentDiagnosis = await preflightDevin({
          executable: config.config.executable,
          inheritedMcpPolicy,
          nonInteractive,
          cwd,
          probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
          minimumSupportedVersion: MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
        });
      },
    },
  };
}

/** Wiring for the read-only `plan` command; it does not diagnose an implementer. */
export async function createPlanDependencies(
  options: CreatePlanDepsOptions = {},
): Promise<PlanDependencies> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryPath = options.repositoryPath ?? cwd;
  const useLocalFakes =
    options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";

  return {
    github: useLocalFakes
      ? createFakeGitHubAdapter()
      : options.localOnly
        ? createLocalGitHubAdapter({ cwd: repositoryPath })
        : createGitHubAdapter({ cwd, executable: "gh" }),
    codex: useLocalFakes ? createFakeCodexForDelivery() : createCodexBridge(),
    planStore: new FileSystemPlanArtifactStore({
      rootDir: resolveRunsRoot(options.runsRoot),
    }),
  };
}

/** Wiring for re-reviewing an existing delivery Run without starting an agent. */
export async function createReviewDependencies(
  options: CreateReviewDepsOptions = {},
): Promise<ReviewDependencies> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryPath = options.repositoryPath ?? cwd;
  const useLocalFakes =
    options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";

  return {
    github: useLocalFakes
      ? createFakeGitHubAdapter()
      : options.localOnly
        ? createLocalGitHubAdapter({ cwd: repositoryPath })
        : createGitHubAdapter({ cwd, executable: "gh" }),
    git: useLocalFakes
      ? createFakeGitAdapter()
      : createGitAdapter({
          expectedRepository: options.repository,
          allowMissingRemote: options.localOnly,
        }),
    codex: useLocalFakes ? createFakeCodexForDelivery() : createCodexBridge(),
    runStore: new FileSystemRunStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
  };
}

/** Wiring for the safety-checked `cleanup` command; it never starts an agent. */
export async function createCleanupDependencies(
  options: CreateCleanupDepsOptions = {},
): Promise<CleanupDependencies> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryPath = options.repositoryPath ?? cwd;
  const useLocalFakes =
    options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";

  return {
    github: useLocalFakes
      ? createFakeGitHubAdapter()
      : options.localOnly
        ? createLocalGitHubAdapter({ cwd: repositoryPath })
        : createGitHubAdapter({ cwd, executable: "gh" }),
    git: useLocalFakes
      ? createFakeGitAdapter()
      : createGitAdapter({
          expectedRepository: options.repository,
          allowMissingRemote: options.localOnly,
        }),
    runStore: new FileSystemRunStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
  };
}

/** Wiring for deterministic discovery from GitHub/local Issues plus supplied observations. */
export async function createDiscoverDependencies(
  options: CreateDiscoverDepsOptions = {},
): Promise<DiscoverDependencies> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryPath = options.repositoryPath ?? cwd;
  const useLocalFakes =
    options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";

  return {
    github: useLocalFakes
      ? createFakeGitHubAdapter()
      : options.localOnly
        ? createLocalGitHubAdapter({ cwd: repositoryPath })
        : createGitHubAdapter({ cwd, executable: "gh" }),
    artifactStore: new FileSystemDiscoveryArtifactStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
  };
}

/** Wiring for deterministic hypothesis structuring from an existing Issue. */
export async function createHypothesisDependencies(
  options: CreateHypothesisDepsOptions = {},
): Promise<HypothesisDependencies> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryPath = options.repositoryPath ?? cwd;
  const useLocalFakes = options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";
  return {
    github: useLocalFakes
      ? createFakeGitHubAdapter()
      : options.localOnly
        ? createLocalGitHubAdapter({ cwd: repositoryPath })
        : createGitHubAdapter({ cwd, executable: "gh" }),
    artifactStore: new FileSystemHypothesisArtifactStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
  };
}

/** Wiring for human-gated Problem draft promotion. */
export async function createPromoteDependencies(
  options: CreatePromoteDepsOptions = {},
): Promise<PromoteDependencies> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryPath = options.repositoryPath ?? cwd;
  const useLocalFakes = options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";
  return {
    github: useLocalFakes
      ? createFakeGitHubAdapter()
      : options.localOnly
        ? createLocalGitHubAdapter({ cwd: repositoryPath })
        : createGitHubAdapter({ cwd, executable: "gh" }),
    artifactStore: new FileSystemProblemArtifactStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
  };
}

/** Wiring for evidence-preserving solution comparison. */
export async function createExploreDependencies(options: CreateExploreDepsOptions = {}): Promise<ExploreDependencies> {
  const cwd = options.cwd ?? process.cwd(); const repositoryPath = options.repositoryPath ?? cwd;
  const useLocalFakes = options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";
  return {
    github: useLocalFakes ? createFakeGitHubAdapter() : options.localOnly ? createLocalGitHubAdapter({ cwd: repositoryPath }) : createGitHubAdapter({ cwd, executable: "gh" }),
    artifactStore: new FileSystemExploreArtifactStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
  };
}

/** Wiring for human-gated Requirement / Feature drafts. */
export async function createRequireDependencies(options: CreateRequireDepsOptions = {}): Promise<RequireDependencies> {
  const cwd = options.cwd ?? process.cwd(); const repositoryPath = options.repositoryPath ?? cwd;
  const useLocalFakes = options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";
  return { github: useLocalFakes ? createFakeGitHubAdapter() : options.localOnly ? createLocalGitHubAdapter({ cwd: repositoryPath }) : createGitHubAdapter({ cwd, executable: "gh" }), artifactStore: new FileSystemRequirementArtifactStore({ rootDir: resolveRunsRoot(options.runsRoot) }) };
}

/** Wiring for human-gated post-release Measurement drafts. */
export async function createMeasureDependencies(options: CreateMeasureDepsOptions = {}): Promise<MeasureDependencies> {
  const cwd = options.cwd ?? process.cwd(); const repositoryPath = options.repositoryPath ?? cwd;
  const useLocalFakes = options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";
  return { github: useLocalFakes ? createFakeGitHubAdapter() : options.localOnly ? createLocalGitHubAdapter({ cwd: repositoryPath }) : createGitHubAdapter({ cwd, executable: "gh" }), artifactStore: new FileSystemMeasurementArtifactStore({ rootDir: resolveRunsRoot(options.runsRoot) }) };
}
