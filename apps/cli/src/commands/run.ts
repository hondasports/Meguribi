import { homedir } from "node:os";
import path from "node:path";
import {
  resumeDelivery,
  runDelivery,
  type DeliveryDependencies,
  type DeliveryResult,
  type InheritedMcpPolicy,
  type ResumeDeliveryInput,
  type RunState,
  type RunDeliveryInput,
} from "@meguribi/core";
import { DEFAULT_VERIFY_TIMEOUT_MS } from "@meguribi/adapters";
import { parseIssueTarget } from "../target.js";

const DEFAULT_PROTECTED_PATHS = [
  ".env",
  ".env.*",
  ".github/workflows/**",
  "**/*secret*",
] as const;

function localDataRoot(): string {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "meguribi");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "meguribi");
  }
  return path.join(homedir(), ".local", "share", "meguribi");
}

function repositoryPathSegment(repository: string): string {
  return repository.split("/").filter(Boolean).join(path.sep);
}

function defaultWorktreePath(repository: string, issueNumber: number): string {
  return path.join(localDataRoot(), "worktrees", repositoryPathSegment(repository), `issue-${String(issueNumber)}`);
}

function defaultArtifactRoot(repository: string, issueNumber: number): string {
  return path.join(localDataRoot(), "runs", repositoryPathSegment(repository), `issue-${String(issueNumber)}`);
}

function invocationArtifactRoot(repository: string, issueNumber: number): string {
  return path.join(
    defaultArtifactRoot(repository, issueNumber),
    `${String(Date.now())}-${String(process.pid)}`,
  );
}

export interface DeliveryCommandOptions {
  json?: boolean;
  nonInteractive?: boolean;
  allowInheritedMcp?: boolean;
  implementer?: string;
  local?: boolean;
  maxFixAttempts?: number;
  noCommit?: boolean;
  noPush?: boolean;
  noPr?: boolean;
  runId?: string;
  repoPath?: string;
  worktreePath?: string;
  base?: string;
  branch?: string;
}

export interface DeliveryCommandDependencies {
  delivery?: DeliveryDependencies;
  inheritedMcpPolicy?: InheritedMcpPolicy;
  runDelivery?: typeof runDelivery;
  resumeDelivery?: typeof resumeDelivery;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  createAbortController?: () => AbortController;
  installSignalHandlers?: (controller: AbortController) => () => void;
}

function defaultSignalInstaller(controller: AbortController): () => void {
  const onSigInt = () => {
    controller.abort();
  };
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigInt);
  return () => {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigInt);
  };
}

function progress(stderr: (text: string) => void, message: string): void {
  stderr(`${message}\n`);
}

function formatStateProgress(state: Readonly<RunState>): string {
  const completed = state.completedSteps.length > 0
    ? ` completed=${state.completedSteps.join(",")}`
    : "";
  const fixAttempts = state.fixAttempts > 0 ? ` fixAttempt=${String(state.fixAttempts)}` : "";
  return `[meguribi] run=${state.runId} status=${state.status} step=${state.currentStep ?? "-"}${fixAttempts}${completed}`;
}

function withProgress(
  delivery: DeliveryDependencies,
  stderr: (text: string) => void,
): DeliveryDependencies {
  let lastKey: string | undefined;
  return {
    ...delivery,
    onStateChange: async (state) => {
      const key = `${state.status}|${state.currentStep ?? ""}|${state.fixAttempts}|${state.completedSteps.join(",")}`;
      if (key === lastKey) return;
      lastKey = key;
      progress(stderr, formatStateProgress(state));
      await delivery.onStateChange?.(state);
    },
  };
}

function formatHuman(result: DeliveryResult): string {
  const lines = [
    `Run: ${result.runId}`,
    `Status: ${result.status}`,
    `Published: ${result.published ? "yes" : "no"}`,
  ];
  if (result.pullRequestNumber) {
    lines.push(`Draft PR: #${String(result.pullRequestNumber)}`);
  }
  if (result.reasons.length > 0) {
    lines.push("Reasons:");
    for (const reason of result.reasons) {
      lines.push(`- ${reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function emitResult(
  result: DeliveryResult,
  options: DeliveryCommandOptions,
  writeOut: (text: string) => void,
): number {
  if (options.json) {
    writeOut(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeOut(formatHuman(result));
  }
  if (result.published) {
    return 0;
  }
  if (result.status === "cancelled") {
    return 130;
  }
  return 1;
}

function buildRunInput(
  target: string,
  options: DeliveryCommandOptions,
  deps: DeliveryCommandDependencies,
  abortSignal: AbortSignal,
  inheritedMcpPolicy: InheritedMcpPolicy,
): RunDeliveryInput {
  const parsed = parseIssueTarget(target);
  const cwd = deps.cwd ?? process.cwd();
  return {
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
    repositoryPath: options.repoPath ?? cwd,
    worktreePath: options.worktreePath ?? defaultWorktreePath(parsed.repository, parsed.issueNumber),
    branch: options.branch ?? `meguribi/issue-${String(parsed.issueNumber)}`,
    baseRef:
      options.local && (options.base === undefined || options.base === "origin/main")
        ? "HEAD"
        : options.base ?? "origin/main",
    repositoryRules: "Follow AGENTS.md",
    completionCriteria: ["Verification commands pass", "Codex review does not require changes"],
    outOfScope: [],
    requiredLabels: ["agent:ready"],
    protectedPaths: [...DEFAULT_PROTECTED_PATHS],
    verifyCommands: [
      { name: "lint", run: "pnpm lint" },
      { name: "typecheck", run: "pnpm typecheck" },
      { name: "test", run: "pnpm test" },
      { name: "build", run: "pnpm build" },
    ],
    inheritedMcpPolicy,
    allowInheritedMcp: options.allowInheritedMcp ?? false,
    nonInteractive: options.nonInteractive ?? false,
    maxFixAttempts: options.maxFixAttempts ?? 2,
    artifactRootForDevin: invocationArtifactRoot(parsed.repository, parsed.issueNumber),
    abortSignal,
    verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    noCommit: options.noCommit,
    noPush: options.noPush,
    noPr: options.noPr,
  };
}

function buildResumeInput(
  target: string,
  options: DeliveryCommandOptions,
  deps: DeliveryCommandDependencies,
  abortSignal: AbortSignal,
  inheritedMcpPolicy: InheritedMcpPolicy,
): ResumeDeliveryInput {
  const parsed = parseIssueTarget(target);
  const cwd = deps.cwd ?? process.cwd();
  return {
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
    runId: options.runId,
    repositoryPath: options.repoPath ?? cwd,
    repositoryRules: "Follow AGENTS.md",
    protectedPaths: [...DEFAULT_PROTECTED_PATHS],
    verifyCommands: [
      { name: "lint", run: "pnpm lint" },
      { name: "typecheck", run: "pnpm typecheck" },
      { name: "test", run: "pnpm test" },
      { name: "build", run: "pnpm build" },
    ],
    nonInteractive: options.nonInteractive ?? false,
    allowInheritedMcp: options.allowInheritedMcp ?? false,
    inheritedMcpPolicy,
    artifactRootForDevin: defaultArtifactRoot(parsed.repository, parsed.issueNumber),
    abortSignal,
    verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    noCommit: options.noCommit,
    noPush: options.noPush,
    noPr: options.noPr,
  };
}

async function resolveDeliveryWiring(
  target: string,
  options: DeliveryCommandOptions,
  deps: DeliveryCommandDependencies,
): Promise<{ delivery: DeliveryDependencies; inheritedMcpPolicy: InheritedMcpPolicy }> {
  if (deps.delivery) {
    return {
      delivery: deps.delivery,
      // DI tests may omit this; default warn matches previous CLI behavior.
      inheritedMcpPolicy: deps.inheritedMcpPolicy ?? "warn",
    };
  }
  const wiring = await (
    await import("../wiring/create-delivery-deps.js")
  ).createDeliveryDeps({
    cwd: deps.cwd,
    repositoryPath: options.repoPath ?? deps.cwd ?? process.cwd(),
    repository: parseIssueTarget(target).repository,
    nonInteractive: options.nonInteractive,
    implementer: options.implementer,
    allowInheritedMcp: options.allowInheritedMcp,
    localOnly: options.local,
  });
  return {
    delivery: wiring.deps,
    inheritedMcpPolicy: deps.inheritedMcpPolicy ?? wiring.inheritedMcpPolicy,
  };
}

export async function runRunCommand(
  target: string,
  options: DeliveryCommandOptions = {},
  deps: DeliveryCommandDependencies = {},
): Promise<{ exitCode: number; result?: DeliveryResult }> {
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const wiring = await resolveDeliveryWiring(target, options, deps);
  const run = deps.runDelivery ?? runDelivery;
  const controller = (deps.createAbortController ?? (() => new AbortController()))();
  const uninstall =
    (deps.installSignalHandlers ?? defaultSignalInstaller)(controller);

  try {
    progress(writeErr, `Starting delivery for ${target}…`);
    const result = await run(
      buildRunInput(target, options, deps, controller.signal, wiring.inheritedMcpPolicy),
      withProgress(wiring.delivery, writeErr),
    );
    progress(writeErr, `Delivery finished: ${result.status}`);
    return { exitCode: emitResult(result, options, writeOut), result };
  } finally {
    uninstall();
  }
}

export async function runResumeCommand(
  target: string,
  options: DeliveryCommandOptions = {},
  deps: DeliveryCommandDependencies = {},
): Promise<{ exitCode: number; result?: DeliveryResult }> {
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const wiring = await resolveDeliveryWiring(target, options, deps);
  const resume = deps.resumeDelivery ?? resumeDelivery;
  const controller = (deps.createAbortController ?? (() => new AbortController()))();
  const uninstall =
    (deps.installSignalHandlers ?? defaultSignalInstaller)(controller);

  try {
    progress(
      writeErr,
      `Resuming delivery for ${target}${options.runId ? ` (run ${options.runId})` : ""}…`,
    );
    const result = await resume(
      buildResumeInput(target, options, deps, controller.signal, wiring.inheritedMcpPolicy),
      withProgress(wiring.delivery, writeErr),
    );
    progress(writeErr, `Resume finished: ${result.status}`);
    return { exitCode: emitResult(result, options, writeOut), result };
  } finally {
    uninstall();
  }
}
