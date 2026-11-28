import { homedir } from "node:os";
import path from "node:path";
import {
  createCodexAdapter,
  captureGitWorktreeSnapshot,
  createCommandVerifier,
  assertAcpServerRunnable,
  createAcpRoleAgent,
  createAcpServerImplementer,
  createCursorAcpAdapter,
  createDefaultPolicyEngine,
  createDevinAcpAdapter,
  createFakeCodexForDelivery,
  createFakeGitAdapter,
  createFakeGitHubAdapter,
  createFakeDeliveryDeps,
  createFakeDiscussionRoleAgent as createAdaptersFakeDiscussionRoleAgent,
  specifyApprovedConclusion,
  createFakeVerifier,
  createGitAdapter,
  createGitHubAdapter,
  createLocalGitHubAdapter,
  CodexSdkClient,
  digestSource,
  diagnoseAcpServer,
  diagnoseCursor,
  diagnoseDevin,
  FileSystemRunStore,
  FileSystemDiscussionStore,
  parseDiscussionEnvelope,
  summarizeDiscussion,
  hashConclusion,
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
  createRoleAgentPlanningBridge,
  createDevinMcpIsolationFactory,
  resolveAcpServerExecutable,
  resolveAcpServerMainCli,
  createCodexExecRoleAgent,
  diagnoseCodexExec,
} from "@meguribi/adapters";
import {
  loadAgentsConfig,
  loadCursorConfig,
  loadDevinConfig,
  loadImplementerConfig,
} from "@meguribi/config";
import { buildSpecificationPrompt, buildSummarizerPrompt, resolveDiscussionMcpPolicy, RoleAssignmentError, validateRoleAssignments, type RunStore } from "@meguribi/core";
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
  DiscussionMcpPolicy,
  LiveLogEvent,
  PlanDependencies,
  ReviewDependencies,
  RoleAgent,
  AgentProfile,
  DiscussionConclusion,
  DiscussionStorePort,
  GitAdapter,
  GitHubAdapter,
  PolicyEngine,
  SummarizeDiscussionInput,
  DiscussToPrDependencies,
} from "@meguribi/core";
import type { CodexClient, CodexWorkspaceGuard } from "@meguribi/adapters";

export interface AgentWiringOverrides {
  userConfigPath?: string;
  environment?: NodeJS.ProcessEnv;
  /** Run 状態ルート。MCP 隔離 config などの Meguribi 管理ファイルの配置に使う。 */
  runsRoot?: string;
  loadAgentsConfig?: typeof loadAgentsConfig;
  loadImplementerConfig?: typeof loadImplementerConfig;
  loadDevinConfig?: typeof loadDevinConfig;
  loadCursorConfig?: typeof loadCursorConfig;
  diagnoseAcpServer?: typeof diagnoseAcpServer;
  diagnoseDevin?: typeof diagnoseDevin;
  diagnoseCursor?: typeof diagnoseCursor;
  diagnoseCodexExec?: typeof diagnoseCodexExec;
  createAcpRoleAgent?: typeof createAcpRoleAgent;
  createCodexExecRoleAgent?: typeof createCodexExecRoleAgent;
  createRoleAgentPlanningBridge?: typeof createRoleAgentPlanningBridge;
  createCodexBridge?: typeof createCodexBridge;
  createAcpServerImplementer?: typeof createAcpServerImplementer;
}

export interface CreateDeliveryDepsOptions extends AgentWiringOverrides {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  nonInteractive?: boolean;
  implementer?: string;
  allowInheritedMcp?: boolean;
  onAgentEvent?: (event: LiveLogEvent) => void;
  /**
   * Prefer local fakes for GitHub/Git/Codex/Verifier.
   * Devin ACP facade and FileSystemRunStore stay real so ACP implement works.
   * Also enabled when MEGURIBI_DELIVERY_FAKES=1.
   */
  useLocalFakes?: boolean;
  runsRoot?: string;
}

export interface CreatePlanDepsOptions extends AgentWiringOverrides {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  useLocalFakes?: boolean;
  runsRoot?: string;
}

export interface CreateReviewDepsOptions extends AgentWiringOverrides {
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

export interface CreateExploreDepsOptions {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  useLocalFakes?: boolean;
  runsRoot?: string;
}
export interface CreateRequireDepsOptions {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  useLocalFakes?: boolean;
  runsRoot?: string;
}
export interface CreateMeasureDepsOptions {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  localOnly?: boolean;
  useLocalFakes?: boolean;
  runsRoot?: string;
}

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

export function createCodexBridge(options: CodexBridgeOptions = {}): DeliveryDependencies["codex"] {
  const adapter = createCodexAdapter({ client: options.client ?? new CodexSdkClient() });
  const workspaceSnapshot = options.workspaceSnapshot ?? captureWorkspaceSnapshot;
  return {
    createPlan: async (input) => {
      const issue = issueContext(input.issue);
      const workspace = await createWorkspaceGuard(input.repositoryPath, workspaceSnapshot);
      return adapter.createPlan({
        repositoryPath: input.repositoryPath,
        issue,
        userRequest: input.userRequest,
        repositoryRules: input.repositoryRules,
        completionCriteria: input.completionCriteria,
        outOfScope: input.outOfScope,
        sourceDigests: {
          issue: digestSource(issue),
          repository: workspace.sourceDigest,
          ...(input.userRequest === undefined
            ? {}
            : { userRequest: digestSource(input.userRequest) }),
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

function configSourceOptions(options: AgentWiringOverrides): {
  userConfigPath?: string;
  environment?: NodeJS.ProcessEnv;
} {
  return {
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
  };
}

function isSdkCodex(profile: AgentProfile): boolean {
  return profile.kind === "codex" && profile.transport === "sdk";
}

function assertSupportedPlanningTransport(
  profile: AgentProfile,
  role: "planner" | "reviewer",
): void {
  if (profile.transport === "sdk" && profile.kind !== "codex") {
    throw new RoleAssignmentError(
      "transport_unsupported",
      `${role} profile ${profile.id} uses unsupported sdk transport for kind ${profile.kind}`,
      "`kind: codex` の sdk プロファイル、または `transport: acp` のプロファイルを選んでください",
    );
  }
}

function requiredProfile(profiles: readonly AgentProfile[], id: string): AgentProfile {
  const profile = profiles.find((candidate) => candidate.id === id);
  if (profile === undefined) {
    throw new Error(`Role profile is missing after validation: ${id}`);
  }
  return profile;
}

function unusedSdkRoleAgent(profile: AgentProfile): RoleAgent {
  return {
    profileId: profile.id,
    kind: profile.kind,
    async openSession() {
      throw new Error(`SDK profile ${profile.id} must be handled by createCodexBridge`);
    },
  };
}

function roleAgentArtifactRoot(runsRoot?: string): string {
  return path.join(resolveRunsRoot(runsRoot), "role-agent-artifacts");
}

interface AcpPlanningAgentOptions extends AgentWiringOverrides {
  repositoryPath: string;
  nonInteractive: boolean;
  /** createDiscussionDependencies 経由の相談/議論 Run でのみ true。 */
  discussionRun?: boolean;
  /** 議論 Run 限定の明示 MCP 方針。planner/reviewer/delivery では未定義のまま。 */
  discussionMcpPolicy?: DiscussionMcpPolicy;
}

function effectiveDiscussionMcpPolicy(
  configured: readonly InheritedMcpPolicy[],
  discussionMcpPolicy: DiscussionMcpPolicy | undefined,
): DiscussionMcpPolicy | undefined {
  if (discussionMcpPolicy === undefined) {
    return undefined;
  }
  return resolveDiscussionMcpPolicy({ configured, discussionMcpPolicy });
}

function profileWithInheritedMcpPolicy(
  profile: AgentProfile,
  inheritedMcpPolicy: InheritedMcpPolicy | undefined,
): AgentProfile {
  if (inheritedMcpPolicy === undefined) {
    return profile;
  }
  return { ...profile, inheritedMcpPolicy };
}

function discussionMcpPolicyOption(options: AcpPlanningAgentOptions): {
  discussionMcpPolicy?: DiscussionMcpPolicy;
} {
  return options.discussionMcpPolicy === undefined
    ? {}
    : { discussionMcpPolicy: options.discussionMcpPolicy };
}

async function createDevinPlanningAgent(
  profile: AgentProfile,
  options: AcpPlanningAgentOptions,
): Promise<RoleAgent> {
  const loadConfig = options.loadDevinConfig ?? loadDevinConfig;
  const diagnose = options.diagnoseDevin ?? diagnoseDevin;
  const createRoleAgent = options.createAcpRoleAgent ?? createAcpRoleAgent;
  const config = await loadConfig({
    repositoryPath: options.repositoryPath,
    cli: {},
    nonInteractive: options.nonInteractive,
    ...configSourceOptions(options),
    ...discussionMcpPolicyOption(options),
  });
  const configuredMcpPolicy = config.config.inheritedMcpPolicy;
  const effectiveMcpPolicy = effectiveDiscussionMcpPolicy(
    [configuredMcpPolicy, profile.inheritedMcpPolicy],
    options.discussionMcpPolicy,
  );
  const diagnosisMcpPolicy = effectiveMcpPolicy ?? configuredMcpPolicy;
  const roleProfile = profileWithInheritedMcpPolicy(profile, effectiveMcpPolicy);
  const diagnosis = await diagnose({
    executable: config.config.executable,
    inheritedMcpPolicy: diagnosisMcpPolicy,
    nonInteractive: options.nonInteractive,
    cwd: options.repositoryPath,
    probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
    minimumSupportedVersion: MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
  });
  // deny 解決時はユーザーのグローバル MCP を継承しない根本隔離を適用する。
  // XDG_CONFIG_HOME を Meguribi 管理ディレクトリへ向け、read_config_from を
  // 全て false にした config で import/cloud/user 由来の継承を遮断する。
  // 認証は XDG data dir 側の credentials.toml で維持され、永続設定は変更しない。
  // in-process 強制で共有 daemon 経由の隔離バイパスを防ぐ。検知は安全網として残る。
  // 相談/議論 Run 限定。planner/reviewer/delivery には広げない。
  // 隔離 dir は openSession ごとに mkdtemp で作成し、close/例外時に自分の分だけ
  // 片付ける。繰り返しの相談で一時 dir が残り続けないようにするため、
  // wiring 時点では作成しない。
  const isolationFactory = options.discussionRun === true && diagnosisMcpPolicy === "deny"
    ? createDevinMcpIsolationFactory({
        // runsRoot 配下なら Meguribi 管理の信頼済みストア内に収まる。
        isolationRootParent: options.runsRoot ?? "",
        // 呼び出し側が指定した env を process.env で上書きしない。
        baseEnv: options.environment ?? process.env,
      })
    : undefined;
  return createRoleAgent({
    profile: roleProfile,
    executable: config.config.executable,
    acpArgs: ["acp"],
    diagnosis,
    mode: options.nonInteractive ? "non-interactive" : "interactive",
    ...(isolationFactory ? { sessionEnvHook: isolationFactory } : {}),
    ...discussionMcpPolicyOption(options),
  });
}

async function createCursorPlanningAgent(
  profile: AgentProfile,
  options: AcpPlanningAgentOptions,
): Promise<RoleAgent> {
  const loadConfig = options.loadCursorConfig ?? loadCursorConfig;
  const diagnose = options.diagnoseCursor ?? diagnoseCursor;
  const createRoleAgent = options.createAcpRoleAgent ?? createAcpRoleAgent;
  const config = await loadConfig({
    repositoryPath: options.repositoryPath,
    cli: {},
    nonInteractive: options.nonInteractive,
    ...configSourceOptions(options),
    ...discussionMcpPolicyOption(options),
  });
  const configuredMcpPolicy = config.config.inheritedMcpPolicy;
  const effectiveMcpPolicy = effectiveDiscussionMcpPolicy(
    [configuredMcpPolicy, profile.inheritedMcpPolicy],
    options.discussionMcpPolicy,
  );
  const diagnosisMcpPolicy = effectiveMcpPolicy ?? configuredMcpPolicy;
  const roleProfile = profileWithInheritedMcpPolicy(profile, effectiveMcpPolicy);
  const diagnosis = await diagnose({
    executable: config.config.executable,
    inheritedMcpPolicy: diagnosisMcpPolicy,
    nonInteractive: options.nonInteractive,
    cwd: options.repositoryPath,
    probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
    minimumSupportedVersion: MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
  });
  return createRoleAgent({
    profile: roleProfile,
    executable: diagnosis.executable.path ?? config.config.executable,
    acpArgs: ["acp"],
    diagnosis,
    mode: options.nonInteractive ? "non-interactive" : "interactive",
    ...discussionMcpPolicyOption(options),
  });
}

function mainCliEnvironment(
  mainCli: ReturnType<typeof resolveAcpServerMainCli>,
  options: Pick<AgentWiringOverrides, "environment">,
): NodeJS.ProcessEnv | undefined {
  if (mainCli === undefined) return undefined;
  return {
    ...(options.environment ?? process.env),
    [mainCli.executableEnvVar]: mainCli.executable,
  };
}

function assertNativeCodexRunnable(diagnosis: { runnable: boolean; errors: readonly { message: string }[] }): void {
  if (!diagnosis.runnable) {
    throw new Error(diagnosis.errors[0]?.message ?? "Codex CLI is not runnable according to preflight diagnosis");
  }
}

async function createAcpPlanningAgent(
  profile: AgentProfile,
  options: AcpPlanningAgentOptions,
): Promise<RoleAgent> {
  if (profile.kind === "devin") {
    return createDevinPlanningAgent(profile, options);
  }
  if (profile.kind === "cursor") {
    return createCursorPlanningAgent(profile, options);
  }
  const effectiveMcpPolicy = effectiveDiscussionMcpPolicy(
    [profile.inheritedMcpPolicy],
    options.discussionMcpPolicy,
  );
  const diagnosisMcpPolicy = effectiveMcpPolicy ?? profile.inheritedMcpPolicy;
  const roleProfile = profileWithInheritedMcpPolicy(profile, effectiveMcpPolicy);
  const mainCli = resolveAcpServerMainCli(profile, options.environment ?? process.env);
  const mainCliEnv = mainCliEnvironment(mainCli, options);

  if (
    options.discussionRun === true &&
    profile.kind === "codex" &&
    mainCli !== undefined &&
    diagnosisMcpPolicy === "deny"
  ) {
    const diagnoseNative = options.diagnoseCodexExec ?? diagnoseCodexExec;
    const createNativeRoleAgent = options.createCodexExecRoleAgent ?? createCodexExecRoleAgent;
    const diagnosis = await diagnoseNative({
      profile: roleProfile,
      executable: mainCli.executable,
      probeTimeoutMs: Math.min(profile.startupTimeoutMs, 10_000),
      ...(mainCliEnv === undefined ? {} : { env: mainCliEnv }),
    });
    assertNativeCodexRunnable(diagnosis);
    return createNativeRoleAgent({
      profile: roleProfile,
      executable: mainCli.executable,
      mcpPolicy: "deny",
      ...(mainCliEnv === undefined ? {} : { env: mainCliEnv }),
    });
  }

  const diagnose = options.diagnoseAcpServer ?? diagnoseAcpServer;
  const createRoleAgent = options.createAcpRoleAgent ?? createAcpRoleAgent;
  const resolvedExecutable = resolveAcpServerExecutable(profile);
  const diagnosis = await diagnose({
    profile: roleProfile,
    executable: resolvedExecutable.executable,
    executableArgs: [...resolvedExecutable.executableArgs],
    cwd: options.repositoryPath,
    nonInteractive: options.nonInteractive,
    probeTimeoutMs: Math.min(profile.startupTimeoutMs, 10_000),
    ...(mainCliEnv === undefined ? {} : { env: mainCliEnv }),
  });
  return createRoleAgent({
    profile: roleProfile,
    executable: resolvedExecutable.executable,
    executableArgs: [...resolvedExecutable.executableArgs],
    diagnosis,
    mode: options.nonInteractive ? "non-interactive" : "interactive",
    ...(mainCliEnv === undefined ? {} : { env: mainCliEnv }),
    ...discussionMcpPolicyOption(options),
  });
}

async function createConfiguredCodexBridge(
  options: AgentWiringOverrides & {
    repositoryPath: string;
    runsRoot?: string;
    nonInteractive: boolean;
    onEvent?: (event: LiveLogEvent) => void;
  },
): Promise<DeliveryDependencies["codex"]> {
  const loadAgents = options.loadAgentsConfig ?? loadAgentsConfig;
  const createSdkBridge = options.createCodexBridge ?? createCodexBridge;
  const createPlanningBridge =
    options.createRoleAgentPlanningBridge ?? createRoleAgentPlanningBridge;
  const agents = await loadAgents({
    repositoryPath: options.repositoryPath,
    cli: {},
    nonInteractive: options.nonInteractive,
    ...configSourceOptions(options),
  });
  const planner = requiredProfile(agents.profiles, agents.roles.planner);
  const reviewer = requiredProfile(agents.profiles, agents.roles.reviewer);
  assertSupportedPlanningTransport(planner, "planner");
  assertSupportedPlanningTransport(reviewer, "reviewer");
  const plannerIsSdk = isSdkCodex(planner);
  const reviewerIsSdk = isSdkCodex(reviewer);

  if (plannerIsSdk && reviewerIsSdk) {
    return createSdkBridge();
  }

  const plannerAgent = plannerIsSdk
    ? unusedSdkRoleAgent(planner)
    : await createAcpPlanningAgent(planner, options);
  const reviewerAgent = reviewerIsSdk
    ? unusedSdkRoleAgent(reviewer)
    : await createAcpPlanningAgent(reviewer, options);
  const roleBridge = createPlanningBridge({
    planner: plannerAgent,
    reviewer: reviewerAgent,
    artifactRoot: roleAgentArtifactRoot(options.runsRoot),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  const sdkBridge = plannerIsSdk || reviewerIsSdk ? createSdkBridge() : undefined;

  return {
    createPlan: plannerIsSdk ? sdkBridge!.createPlan : roleBridge.createPlan,
    review: reviewerIsSdk ? sdkBridge!.review : roleBridge.review,
  };
}

async function preflightAcpServer(
  options: AgentWiringOverrides & {
    profile: AgentProfile;
    executable: string;
    executableArgs?: string[];
    cwd: string;
    nonInteractive: boolean;
    env?: NodeJS.ProcessEnv;
  },
) {
  const diagnose = options.diagnoseAcpServer ?? diagnoseAcpServer;
  const diagnosis = await diagnose({
    profile: options.profile,
    executable: options.executable,
    ...(options.executableArgs === undefined ? {} : { executableArgs: options.executableArgs }),
    cwd: options.cwd,
    nonInteractive: options.nonInteractive,
    probeTimeoutMs: Math.min(options.profile.startupTimeoutMs, 10_000),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  assertAcpServerRunnable(diagnosis);
  return diagnosis;
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

  const loadImplementer = options.loadImplementerConfig ?? loadImplementerConfig;
  const config = await loadImplementer({
    repositoryPath: cwd,
    nonInteractive,
    ...configSourceOptions(options),
    cli: {
      ...(options.implementer !== undefined ? { implementer: options.implementer } : {}),
      // The explicit run flag must win over repository config so that a
      // non-interactive local run can proceed when the repository still uses
      // the interactive default (`warn`).
      ...(allowInheritedMcp ? { inheritedMcpPolicy: "allow" } : {}),
    },
  });

  const codex = useLocalFakes
    ? createFakeCodexForDelivery()
    : await createConfiguredCodexBridge({
        ...options,
        repositoryPath: options.repositoryPath ?? cwd,
        nonInteractive,
        ...(options.onAgentEvent ? { onEvent: options.onAgentEvent } : {}),
      });
  const agentEventObserver = options.onAgentEvent
    ? { onAgentEvent: options.onAgentEvent }
    : {};

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

    const deps: DeliveryDependencies = {
      github: useLocalFakes
        ? createFakeGitHubAdapter()
        : options.localOnly
          ? createLocalGitHubAdapter({ cwd: options.repositoryPath ?? cwd })
          : createGitHubAdapter({ cwd, executable: "gh" }),
      git: useLocalFakes
        ? createFakeGitAdapter()
        : createGitAdapter({
            expectedRepository: options.repository,
            allowMissingRemote: options.localOnly,
          }),
      codex,
      implementer,
      implementerProfile: { id: "cursor", kind: "cursor" },
      devin: implementer,
      verifier: useLocalFakes ? createFakeVerifier() : createCommandVerifier(),
      policy: createDefaultPolicyEngine(),
      runStore: new FileSystemRunStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
      ...agentEventObserver,
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
    };
    return { inheritedMcpPolicy, deps };
  }

  if (config.kind === "acp-server") {
    const { profile } = config;
    const inheritedMcpPolicy = profile.inheritedMcpPolicy;
    const resolvedExecutable = resolveAcpServerExecutable(profile);
    const executable = resolvedExecutable.executable;
    const executableArgs = [...resolvedExecutable.executableArgs];
    const mainCliEnv = mainCliEnvironment(
      resolveAcpServerMainCli(profile, options.environment ?? process.env),
      options,
    );
    const diagnosis = await (options.diagnoseAcpServer ?? diagnoseAcpServer)({
      profile,
      executable,
      executableArgs,
      nonInteractive,
      cwd,
      probeTimeoutMs: Math.min(profile.startupTimeoutMs, 10_000),
      ...(mainCliEnv === undefined ? {} : { env: mainCliEnv }),
    });
    let currentDiagnosis = diagnosis;
    const implementer = (options.createAcpServerImplementer ?? createAcpServerImplementer)({
      profile,
      executable,
      executableArgs,
      diagnosis,
      getDiagnosis: () => currentDiagnosis,
      inheritedMcpPolicy,
      mode: nonInteractive ? "non-interactive" : "interactive",
      explicitAllowInheritedMcp: allowInheritedMcp,
      startupTimeoutMs: profile.startupTimeoutMs,
      promptTimeoutMs: profile.turnTimeoutMinutes * 60_000,
      ...(mainCliEnv === undefined ? {} : { env: mainCliEnv }),
    });

    const deps: DeliveryDependencies = {
      github: useLocalFakes
        ? createFakeGitHubAdapter()
        : options.localOnly
          ? createLocalGitHubAdapter({ cwd: options.repositoryPath ?? cwd })
          : createGitHubAdapter({ cwd, executable: "gh" }),
      git: useLocalFakes
        ? createFakeGitAdapter()
        : createGitAdapter({
            expectedRepository: options.repository,
            allowMissingRemote: options.localOnly,
          }),
      codex,
      implementer,
      implementerProfile: { id: profile.id, kind: profile.kind },
      devin: implementer,
      verifier: useLocalFakes ? createFakeVerifier() : createCommandVerifier(),
      policy: createDefaultPolicyEngine(),
      runStore: new FileSystemRunStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
      ...agentEventObserver,
      async assertImplementerReady() {
        currentDiagnosis = await preflightAcpServer({
          ...options,
          profile,
          executable,
          executableArgs,
          cwd,
          nonInteractive,
          ...(mainCliEnv === undefined ? {} : { env: mainCliEnv }),
        });
      },
      async assertDevinReady() {
        currentDiagnosis = await preflightAcpServer({
          ...options,
          profile,
          executable,
          executableArgs,
          cwd,
          nonInteractive,
          ...(mainCliEnv === undefined ? {} : { env: mainCliEnv }),
        });
      },
    };
    return { inheritedMcpPolicy, deps };
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

  const deps: DeliveryDependencies = {
    github: useLocalFakes
      ? createFakeGitHubAdapter()
      : options.localOnly
        ? createLocalGitHubAdapter({ cwd: options.repositoryPath ?? cwd })
        : createGitHubAdapter({ cwd, executable: "gh" }),
    git: useLocalFakes
      ? createFakeGitAdapter()
      : createGitAdapter({
          expectedRepository: options.repository,
          allowMissingRemote: options.localOnly,
        }),
    codex,
    implementer,
    implementerProfile: { id: "devin", kind: "devin" },
    devin: implementer,
    verifier: useLocalFakes ? createFakeVerifier() : createCommandVerifier(),
    policy: createDefaultPolicyEngine(),
    runStore: new FileSystemRunStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
    ...agentEventObserver,
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
  };
  return { inheritedMcpPolicy, deps };
}

/** Wiring for the read-only `plan` command; it does not diagnose an implementer. */
export async function createPlanDependencies(
  options: CreatePlanDepsOptions = {},
): Promise<PlanDependencies> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryPath = options.repositoryPath ?? cwd;
  const useLocalFakes =
    options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";
  const codex = useLocalFakes
    ? createFakeCodexForDelivery()
    : await createConfiguredCodexBridge({
        ...options,
        repositoryPath,
        nonInteractive: false,
      });

  return {
    github: useLocalFakes
      ? createFakeGitHubAdapter()
      : options.localOnly
        ? createLocalGitHubAdapter({ cwd: repositoryPath })
        : createGitHubAdapter({ cwd, executable: "gh" }),
    codex,
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
  const codex = useLocalFakes
    ? createFakeCodexForDelivery()
    : await createConfiguredCodexBridge({
        ...options,
        repositoryPath,
        nonInteractive: false,
      });

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
    codex,
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
    artifactStore: new FileSystemDiscoveryArtifactStore({
      rootDir: resolveRunsRoot(options.runsRoot),
    }),
  };
}

/** Wiring for deterministic hypothesis structuring from an existing Issue. */
export async function createHypothesisDependencies(
  options: CreateHypothesisDepsOptions = {},
): Promise<HypothesisDependencies> {
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
    artifactStore: new FileSystemHypothesisArtifactStore({
      rootDir: resolveRunsRoot(options.runsRoot),
    }),
  };
}

/** Wiring for human-gated Problem draft promotion. */
export async function createPromoteDependencies(
  options: CreatePromoteDepsOptions = {},
): Promise<PromoteDependencies> {
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
    artifactStore: new FileSystemProblemArtifactStore({
      rootDir: resolveRunsRoot(options.runsRoot),
    }),
  };
}

/** Wiring for evidence-preserving solution comparison. */
export async function createExploreDependencies(
  options: CreateExploreDepsOptions = {},
): Promise<ExploreDependencies> {
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
    artifactStore: new FileSystemExploreArtifactStore({
      rootDir: resolveRunsRoot(options.runsRoot),
    }),
  };
}

/** Wiring for human-gated Requirement / Feature drafts. */
export async function createRequireDependencies(
  options: CreateRequireDepsOptions = {},
): Promise<RequireDependencies> {
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
    artifactStore: new FileSystemRequirementArtifactStore({
      rootDir: resolveRunsRoot(options.runsRoot),
    }),
  };
}

/** Wiring for human-gated post-release Measurement drafts. */
export async function createMeasureDependencies(
  options: CreateMeasureDepsOptions = {},
): Promise<MeasureDependencies> {
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
    artifactStore: new FileSystemMeasurementArtifactStore({
      rootDir: resolveRunsRoot(options.runsRoot),
    }),
  };
}

export interface CreateDiscussionDepsOptions extends AgentWiringOverrides {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  runsRoot?: string;
  useLocalFakes?: boolean;
  localOnly?: boolean;
  nonInteractive?: boolean;
  /**
   * Run ごとの参加者上書き（`meguribi discuss --discussants`）。
   * 永続設定（.meguribi.yml）は変更せず、この Run の配線だけに適用する。
   */
  discussants?: readonly string[];
  /** Run ごとの summarizer 上書き。未指定なら roles.summarizer → discussants[0] の従来どおり。 */
  summarizer?: string;
  /**
   * 議論エージェントの MCP 継承に対する Run ごとの明示方針（`meguribi discuss --discussion-mcp-policy`）。
   * 未指定なら従来どおりプロファイルの inheritedMcpPolicy と fail-closed 判定に従う。
   * P4/delivery の許可には波及しない。
   */
  discussionMcpPolicy?: DiscussionMcpPolicy;
}

/**
 * `discuss` / `say` / `approve` / `reject` が使う本番依存。
 * `store` は runId 確定後にしか作れないため `createStore(runId)` で遅延生成する。
 * T7 の workflow 側が要求する `DiscussionDependencies` へは、CLI 側で
 * `store` を束ねて渡す。
 */
export interface DiscussionWiringDependencies {
  github: GitHubAdapter;
  git: GitAdapter;
  policy: PolicyEngine;
  /** core の RunStore ポートが境界。消費側はポートのメソッドだけを使う。 */
  runStore: RunStore;
  discussants: readonly RoleAgent[];
  summarizer: RoleAgent;
  parseEnvelope: typeof parseDiscussionEnvelope;
  summarize(input: SummarizeDiscussionInput): Promise<DiscussionConclusion>;
  hashConclusion: typeof hashConclusion;
  createStore(runId: string): DiscussionStorePort;
  now(): Date;
}

function assertDiscussionTransport(profile: AgentProfile, role: string): void {
  if (profile.transport === "sdk") {
    throw new RoleAssignmentError(
      "transport_unsupported",
      `${role} profile ${profile.id} uses sdk transport, which cannot join multi-turn discussion`,
      "議論に使うプロファイルは `transport: acp` にしてください",
    );
  }
}

function createFakeSpecificationRoleAgent(profile: AgentProfile): RoleAgent {
  const base = createAdaptersFakeDiscussionRoleAgent(profile);
  const payload = {
    problem: null,
    targetUsers: [],
    requirements: [
      {
        id: "req-fake",
        priority: "must",
        statement: "fake specification requirement",
      },
    ],
    acceptanceCriteria: [
      {
        id: "ac-fake",
        seed: "fake acceptance seed",
        given: "an approved conclusion exists",
        when: "the specification is prepared",
        // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then の `then` はデータフィールドであり thenable ではない
        then: "the fake delivery can continue",
        requirementIds: ["req-fake"],
      },
    ],
    inScope: [],
    outOfScope: [],
    testPlan: [],
    successMetrics: [],
    guardrails: [],
    openQuestions: [],
  };

  return {
    ...base,
    async openSession(input) {
      if (input.role !== "specifier") {
        return await base.openSession(input);
      }
      return {
        sessionId: `fake-specifier-${profile.id}`,
        async send() {
          return {
            sessionId: `fake-specifier-${profile.id}`,
            text: [
              "Requirement/specification draft:",
              "```json",
              JSON.stringify(payload, null, 2),
              "```",
            ].join("\n"),
            stopReason: "end_turn",
            events: [],
          };
        },
        async close() {},
      };
    },
  };
}

function assertSpecifierTransport(profile: AgentProfile): void {
  if (profile.transport === "sdk") {
    throw new RoleAssignmentError(
      "transport_unsupported",
      `specifier profile ${profile.id} uses sdk transport, which is not supported by specification generation`,
      "`roles.specifier` または fallback 先の `roles.planner` には `transport: acp` のプロファイルを指定してください",
    );
  }
}

function createFakeDeliveryWiring(
  runStore: RunStore,
  onAgentEvent: ((event: LiveLogEvent) => void) | undefined,
): { deps: DeliveryDependencies; inheritedMcpPolicy: InheritedMcpPolicy } {
  const bundle = createFakeDeliveryDeps();
  return {
    deps: {
      ...bundle.deps,
      runStore,
      ...(onAgentEvent === undefined ? {} : { onAgentEvent }),
    },
    inheritedMcpPolicy: "deny",
  };
}

/** Wiring for the discussion commands (`discuss` / `say` / `approve` / `reject`). */
export async function createDiscussionDependencies(
  options: CreateDiscussionDepsOptions = {},
): Promise<DiscussionWiringDependencies> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryPath = options.repositoryPath ?? cwd;
  const nonInteractive = options.nonInteractive ?? false;
  const useLocalFakes =
    options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";
  const loadAgents = options.loadAgentsConfig ?? loadAgentsConfig;
  const agents = await loadAgents({
    repositoryPath,
    cli: {},
    nonInteractive,
    ...configSourceOptions(options),
  });

  const discussantIds = options.discussants ?? agents.roles.discussants;
  if (discussantIds.length < 2 || discussantIds.length > 4) {
    throw new RoleAssignmentError(
      "invalid_discussants",
      `roles.discussants must list 2 to 4 profiles, but got ${String(discussantIds.length)}`,
      "`.meguribi.yml` の `roles.discussants` に 2〜4 件のプロファイル ID を指定してください",
    );
  }

  const roleAgents = new Map<string, RoleAgent>();
  const buildAgent = async (profile: AgentProfile, role: string): Promise<RoleAgent> => {
    assertDiscussionTransport(profile, role);
    const cached = roleAgents.get(profile.id);
    if (cached !== undefined) {
      return cached;
    }
    const agent = useLocalFakes
      ? createAdaptersFakeDiscussionRoleAgent(profile)
      : await createAcpPlanningAgent(profile, {
          ...options,
          repositoryPath,
          nonInteractive,
          discussionRun: true,
        });
    roleAgents.set(profile.id, agent);
    return agent;
  };

  const discussants: RoleAgent[] = [];
  for (const id of discussantIds) {
    discussants.push(await buildAgent(requiredProfile(agents.profiles, id), "discussant"));
  }
  const summarizerId = options.summarizer ?? agents.roles.summarizer ?? discussantIds[0];
  const summarizer = await buildAgent(
    requiredProfile(agents.profiles, summarizerId as string),
    "summarizer",
  );

  const runStore = new FileSystemRunStore({ rootDir: resolveRunsRoot(options.runsRoot) });
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
    policy: createDefaultPolicyEngine(),
    runStore,
    discussants,
    summarizer,
    parseEnvelope: parseDiscussionEnvelope,
    summarize: (input) => summarizeDiscussion(input, buildSummarizerPrompt),
    hashConclusion,
    createStore: (runId) => new FileSystemDiscussionStore({ runStore, runId }),
    now: () => new Date(),
  };
}

export interface CreateDiscussToPrDepsOptions extends AgentWiringOverrides {
  cwd?: string;
  repositoryPath?: string;
  repository?: string;
  runsRoot?: string;
  useLocalFakes?: boolean;
  localOnly?: boolean;
  nonInteractive?: boolean;
  implementer?: string;
  allowInheritedMcp?: boolean;
  onAgentEvent?: (event: LiveLogEvent) => void;
  /** Run ごとの参加者上書き（discuss 工程）。永続設定は変更しない。 */
  discussants?: readonly string[];
  summarizer?: string;
}

export interface DiscussToPrWiring {
  deps: DiscussToPrDependencies;
  inheritedMcpPolicy: InheritedMcpPolicy;
}

/**
 * `workflow run discuss-to-pr` の本番依存。
 * 議論・delivery・specifier を束ね、implementer と reviewer の同一プロファイルを
 * 既定で禁止する（allowSameImplementerReviewer: true の明示設定だけ例外）。
 */
export async function createDiscussToPrDependencies(
  options: CreateDiscussToPrDepsOptions = {},
): Promise<DiscussToPrWiring> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryPath = options.repositoryPath ?? cwd;
  const nonInteractive = options.nonInteractive ?? false;
  const useLocalFakes =
    options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";

  const loadAgents = options.loadAgentsConfig ?? loadAgentsConfig;
  const agents = await loadAgents({
    repositoryPath,
    cli: {},
    nonInteractive,
    ...configSourceOptions(options),
  });
  validateRoleAssignments({
    discussants: agents.roles.discussants,
    ...(agents.roles.summarizer !== undefined ? { summarizer: agents.roles.summarizer } : {}),
    ...(agents.roles.specifier !== undefined ? { specifier: agents.roles.specifier } : {}),
    planner: agents.roles.planner,
    ...(options.implementer !== undefined || agents.roles.implementer !== undefined
      ? { implementer: options.implementer ?? agents.roles.implementer }
      : {}),
    reviewer: agents.roles.reviewer,
    allowSameImplementerReviewer: agents.roles.allowSameImplementerReviewer,
  }, agents.profiles);

  const discussion = await createDiscussionDependencies({
    ...options,
    cwd,
    repositoryPath,
    nonInteractive,
    useLocalFakes,
  });
  const deliveryWiring = useLocalFakes
    ? createFakeDeliveryWiring(discussion.runStore, options.onAgentEvent)
    : await createDeliveryDeps({
        ...options,
        cwd,
        repositoryPath,
        nonInteractive,
        useLocalFakes,
      });

  const specifierId = agents.roles.specifier ?? agents.roles.planner;
  const specifierProfile = requiredProfile(agents.profiles, specifierId);
  assertSpecifierTransport(specifierProfile);
  const specifier: RoleAgent = useLocalFakes
    ? createFakeSpecificationRoleAgent(specifierProfile)
    : await createAcpPlanningAgent(specifierProfile, {
        ...options,
        repositoryPath,
        nonInteractive,
      });

  // fake 経路でも本番と同じ specifyApprovedConclusion の検証・分類を通し、
  // Requirement/Specification のスキーマ不整合が wiring テストで検出できるようにする。
  const specify: DiscussToPrDependencies["specify"] = (input) =>
    specifyApprovedConclusion({
      specifier,
      cwd: input.cwd,
      artifactRoot: input.artifactRoot,
      conclusion: input.conclusion,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    }, buildSpecificationPrompt);

  return {
    deps: {
      discussion,
      delivery: deliveryWiring.deps,
      specify,
      now: () => new Date(),
    },
    inheritedMcpPolicy: deliveryWiring.inheritedMcpPolicy,
  };
}
