import {
  resumeDelivery,
  runDelivery,
  type DeliveryDependencies,
  type DeliveryResult,
  type InheritedMcpPolicy,
  type ResumeDeliveryInput,
  type RunDeliveryInput,
} from "@meguribi/core";
import { parseIssueTarget } from "../target.js";

const DEFAULT_PROTECTED_PATHS = [
  ".env",
  ".env.*",
  ".github/workflows/**",
  "**/*secret*",
] as const;

export interface DeliveryCommandOptions {
  json?: boolean;
  nonInteractive?: boolean;
  allowInheritedMcp?: boolean;
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
    worktreePath:
      options.worktreePath ??
      `${cwd}/.meguribi-worktrees/issue-${String(parsed.issueNumber)}`,
    branch: options.branch ?? `meguribi/issue-${String(parsed.issueNumber)}`,
    baseRef: options.base ?? "origin/main",
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
    artifactRootForDevin: `${cwd}/.meguribi-artifacts/issue-${String(parsed.issueNumber)}`,
    abortSignal,
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
    artifactRootForDevin: `${cwd}/.meguribi-artifacts/issue-${String(parsed.issueNumber)}`,
    abortSignal,
    noCommit: options.noCommit,
    noPush: options.noPush,
    noPr: options.noPr,
  };
}

async function resolveDeliveryWiring(
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
    nonInteractive: options.nonInteractive,
    allowInheritedMcp: options.allowInheritedMcp,
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
  const wiring = await resolveDeliveryWiring(options, deps);
  const run = deps.runDelivery ?? runDelivery;
  const controller = (deps.createAbortController ?? (() => new AbortController()))();
  const uninstall =
    (deps.installSignalHandlers ?? defaultSignalInstaller)(controller);

  try {
    progress(writeErr, `Starting delivery for ${target}…`);
    const result = await run(
      buildRunInput(target, options, deps, controller.signal, wiring.inheritedMcpPolicy),
      wiring.delivery,
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
  const wiring = await resolveDeliveryWiring(options, deps);
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
      wiring.delivery,
    );
    progress(writeErr, `Resume finished: ${result.status}`);
    return { exitCode: emitResult(result, options, writeOut), result };
  } finally {
    uninstall();
  }
}
