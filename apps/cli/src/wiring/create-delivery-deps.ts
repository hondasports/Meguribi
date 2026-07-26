import { homedir } from "node:os";
import path from "node:path";
import {
  createCodexAdapter,
  createCommandVerifier,
  createDefaultPolicyEngine,
  createDevinAcpAdapter,
  createFakeCodexForDelivery,
  createFakeGitAdapter,
  createFakeGitHubAdapter,
  createFakeVerifier,
  CodexSdkClient,
  diagnoseDevin,
  FileSystemRunStore,
  MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
  preflightDevin,
} from "@meguribi/adapters";
import { loadDevinConfig } from "@meguribi/config";
import type { DeliveryDependencies, InheritedMcpPolicy } from "@meguribi/core";

export interface CreateDeliveryDepsOptions {
  cwd?: string;
  nonInteractive?: boolean;
  allowInheritedMcp?: boolean;
  /**
   * Prefer local fakes for GitHub/Git/Codex/Verifier.
   * Devin ACP facade and FileSystemRunStore stay real so ACP implement works.
   * Also enabled when MEGURIBI_DELIVERY_FAKES=1.
   */
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

function createCodexBridge(): DeliveryDependencies["codex"] {
  const adapter = createCodexAdapter({ client: new CodexSdkClient() });
  return {
    createPlan: async (input) =>
      adapter.createPlan({
        repositoryPath: input.repositoryPath,
        issue: {
          title: input.issue.title,
          body: input.issue.body,
          comments: input.issue.comments.map((comment) => comment.body),
        },
        repositoryRules: input.repositoryRules,
        completionCriteria: input.completionCriteria,
        outOfScope: input.outOfScope,
        sourceDigests: { issue: "cli" },
        workspaceGuard: {
          async snapshot() {
            return "unchanged";
          },
        },
      }),
    review: async (input) =>
      adapter.review({
        repositoryPath: input.repositoryPath,
        issue: {
          title: input.issue.title,
          body: input.issue.body,
          comments: input.issue.comments.map((comment) => comment.body),
        },
        plan: input.plan,
        diff: input.diff,
        changedFiles: input.changedFiles,
        verification: {
          success: input.verification.success,
          commands: input.verification.commands.map((command) => ({
            name: command.name,
            exitCode: command.exitCode,
          })),
        },
        repositoryRules: input.repositoryRules,
        sourceDigests: { issue: "cli" },
        workspaceGuard: {
          async snapshot() {
            return "unchanged";
          },
        },
      }),
  };
}

/**
 * Default delivery wiring for `meguribi run` / `resume`.
 * Real: DevinAcpAdapter, FileSystemRunStore, PolicyEngine.
 * GitHub/Git stay fake until dedicated adapters land (Issue scope).
 */
export async function createDeliveryDeps(
  options: CreateDeliveryDepsOptions = {},
): Promise<{ deps: DeliveryDependencies; inheritedMcpPolicy: InheritedMcpPolicy }> {
  const cwd = options.cwd ?? process.cwd();
  const nonInteractive = options.nonInteractive ?? false;
  const allowInheritedMcp = options.allowInheritedMcp ?? false;
  const useLocalFakes =
    options.useLocalFakes === true || process.env.MEGURIBI_DELIVERY_FAKES === "1";

  const config = await loadDevinConfig({
    repositoryPath: cwd,
    nonInteractive: false,
  });
  const inheritedMcpPolicy = config.config.inheritedMcpPolicy;
  const diagnosis = await diagnoseDevin({
    executable: config.config.executable,
    inheritedMcpPolicy,
    nonInteractive,
    cwd,
    probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
    minimumSupportedVersion: MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
  });

  const devin = createDevinAcpAdapter({
    executable: config.config.executable,
    diagnosis,
    inheritedMcpPolicy,
    mode: nonInteractive ? "non-interactive" : "interactive",
    explicitAllowInheritedMcp: allowInheritedMcp,
    startupTimeoutMs: config.config.startupTimeoutMs,
    promptTimeoutMs: config.config.turnTimeoutMinutes * 60_000,
  });

  return {
    inheritedMcpPolicy,
    deps: {
      github: createFakeGitHubAdapter(),
      git: createFakeGitAdapter(),
      codex: useLocalFakes ? createFakeCodexForDelivery() : createCodexBridge(),
      devin,
      verifier: useLocalFakes ? createFakeVerifier() : createCommandVerifier(),
      policy: createDefaultPolicyEngine(),
      runStore: new FileSystemRunStore({ rootDir: resolveRunsRoot(options.runsRoot) }),
      async assertDevinReady() {
        await preflightDevin({
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

