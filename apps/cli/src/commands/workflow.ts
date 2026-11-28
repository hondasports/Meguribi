import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadRepositoryWorkflows, parseWorkflowDefinition } from "@meguribi/config";
import { homedir } from "node:os";
import {
  createDeliveryWorkflow,
  createDiscussionWorkflow,
  createDiscussToPrWorkflow,
  runDiscussToPr,
  validateWorkflowDefinition,
  type RunDiscussToPrInput,
} from "@meguribi/core";
import { parseIssueTarget } from "../target.js";
import {
  parseParticipantOverride,
  saveParticipantOverride,
} from "./discuss.js";
import {
  createDiscussToPrDependencies,
  type CreateDiscussToPrDepsOptions,
} from "../wiring/create-delivery-deps.js";

export interface WorkflowValidateCommandDependencies {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  readFile?: (path: string) => Promise<string>;
}

export interface WorkflowListCommandOptions {
  repoPath?: string;
}

export interface WorkflowListCommandDependencies {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  cwd?: string;
  loadWorkflows?: typeof loadRepositoryWorkflows;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runWorkflowValidateCommand(
  file: string,
  deps: WorkflowValidateCommandDependencies = {},
): Promise<{ exitCode: number }> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const read = deps.readFile ?? ((pathname: string) => readFile(pathname, "utf8"));

  let definition;
  try {
    definition = parseWorkflowDefinition(await read(file), file);
  } catch (error) {
    stderr(`${errorMessage(error)}\n`);
    return { exitCode: 1 };
  }

  const issues = validateWorkflowDefinition(definition);
  if (issues.length > 0) {
    for (const issue of issues) {
      stderr(`${issue.code} ${issue.stepId ?? "-"}: ${issue.message}\n`);
    }
    return { exitCode: 1 };
  }

  stdout(`OK: ${definition.name} (${String(definition.steps.length)} steps)\n`);
  return { exitCode: 0 };
}

function displayWorkflowPath(filePath: string, repositoryPath: string): string {
  const relative = path.relative(repositoryPath, filePath);
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return filePath;
}

function formatWorkflowLine(name: string, source: string, steps: readonly { id: string }[]): string {
  return `${name} (${source}, ${String(steps.length)} steps): ${steps.map((step) => step.id).join(", ")}\n`;
}

export async function runWorkflowListCommand(
  options: WorkflowListCommandOptions = {},
  deps: WorkflowListCommandDependencies = {},
): Promise<{ exitCode: number }> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const repositoryPath = path.resolve(options.repoPath ?? deps.cwd ?? process.cwd());
  const loadWorkflows = deps.loadWorkflows ?? loadRepositoryWorkflows;
  const delivery = createDeliveryWorkflow(2);
  const discussion = createDiscussionWorkflow();
  const discussToPr = createDiscussToPrWorkflow(3);
  const lines = [
    formatWorkflowLine(delivery.name, "built-in", delivery.steps),
    formatWorkflowLine(discussion.name, "built-in", discussion.steps),
    formatWorkflowLine(discussToPr.name, "built-in", discussToPr.steps),
  ];

  for (const workflow of await loadWorkflows(repositoryPath)) {
    const shownPath = displayWorkflowPath(workflow.path, repositoryPath);
    if (workflow.definition) {
      lines.push(formatWorkflowLine(workflow.definition.name, shownPath, workflow.definition.steps));
    } else {
      lines.push(`${shownPath}: error: ${workflow.error ?? "unknown error"}\n`);
    }
  }

  stdout(lines.join(""));
  return { exitCode: 0 };
}

const DEFAULT_PROTECTED_PATHS = [".env", ".env.*", ".github/workflows/**", "**/*secret*"] as const;

function workflowLocalDataRoot(): string {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "meguribi");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "meguribi");
  }
  return path.join(homedir(), ".local", "share", "meguribi");
}

function workflowPathSegment(repository: string): string {
  return repository.replace("/", "-");
}

export interface WorkflowRunCommandOptions {
  repoPath?: string;
  local?: boolean;
  request?: string;
  nonInteractive?: boolean;
  implementer?: string;
  allowInheritedMcp?: boolean;
  maxFixAttempts?: number;
  /** Run ごとの参加者上書き（カンマ区切り）。永続設定は変更しない。 */
  discussants?: string;
  summarizer?: string;
}

export interface WorkflowRunCommandDependencies {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  cwd?: string;
  abortSignal?: AbortSignal;
  createDependencies?: (
    options: CreateDiscussToPrDepsOptions,
  ) => ReturnType<typeof createDiscussToPrDependencies>;
  runWorkflow?: typeof runDiscussToPr;
}

/**
 * `meguribi workflow run <name> <target>`。
 * 現在実行可能な組み込みワークフローは `discuss-to-pr` のみ。
 * 議論が合意に達すると `awaiting_human` で停止し、承認（`meguribi approve`）で継続する。
 * 自動承認のオプションは設けない（設計書 §6.3 A1）。
 */
export async function runWorkflowRunCommand(
  name: string,
  target: string,
  options: WorkflowRunCommandOptions = {},
  deps: WorkflowRunCommandDependencies = {},
): Promise<{ exitCode: number }> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));

  if (name !== "discuss-to-pr") {
    stderr(
      `ワークフロー "${name}" は実行できません。実行可能な組み込みワークフロー: discuss-to-pr\n` +
        "（議論だけ行う場合は `meguribi discuss <target>`、従来の delivery は `meguribi run <target>` を使ってください）\n",
    );
    return { exitCode: 1 };
  }

  let parsed: ReturnType<typeof parseIssueTarget>;
  try {
    parsed = parseIssueTarget(target);
  } catch (error) {
    stderr(`${errorMessage(error)}\n`);
    return { exitCode: 1 };
  }

  const cwd = deps.cwd ?? process.cwd();
  const repositoryPath = options.repoPath ?? cwd;
  const nonInteractive = options.nonInteractive ?? false;
  const maxFixAttempts = options.maxFixAttempts ?? 2;

  const participantOverride = parseParticipantOverride(options);
  const create = deps.createDependencies ?? createDiscussToPrDependencies;
  const wiring = await create({
    cwd,
    repositoryPath,
    repository: parsed.repository,
    nonInteractive,
    localOnly: options.local,
    ...(options.implementer !== undefined ? { implementer: options.implementer } : {}),
    ...(options.allowInheritedMcp !== undefined ? { allowInheritedMcp: options.allowInheritedMcp } : {}),
    ...(participantOverride.discussants !== undefined
      ? { discussants: participantOverride.discussants }
      : {}),
    ...(participantOverride.summarizer !== undefined
      ? { summarizer: participantOverride.summarizer }
      : {}),
  });

  const worktreePath = path.join(
    workflowLocalDataRoot(),
    "worktrees",
    workflowPathSegment(parsed.repository),
    `issue-${String(parsed.issueNumber)}`,
  );
  const artifactRoot = path.join(
    workflowLocalDataRoot(),
    "runs",
    workflowPathSegment(parsed.repository),
    `issue-${String(parsed.issueNumber)}`,
    `${String(Date.now())}-${String(process.pid)}`,
  );

  const input: RunDiscussToPrInput = {
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
    repositoryPath,
    worktreePath,
    branch: `meguribi/issue-${String(parsed.issueNumber)}`,
    baseRef: options.local ? "HEAD" : "origin/main",
    requiredLabels: ["agent:ready"],
    repositoryRules: "Follow AGENTS.md",
    ...(options.request !== undefined ? { userRequest: options.request } : {}),
    limits: { maxTurns: 20, maxDurationMs: 30 * 60 * 1000, turnTimeoutMs: 5 * 60 * 1000 },
    nonInteractive,
    artifactRoot,
    outOfScope: [],
    protectedPaths: [...DEFAULT_PROTECTED_PATHS],
    verifyCommands: [
      { name: "lint", run: "pnpm lint" },
      { name: "typecheck", run: "pnpm typecheck" },
      { name: "test", run: "pnpm test" },
      { name: "build", run: "pnpm build" },
    ],
    inheritedMcpPolicy: wiring.inheritedMcpPolicy,
    allowInheritedMcp: options.allowInheritedMcp ?? false,
    maxFixAttempts,
    artifactRootForDevin: artifactRoot,
    ...(deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {}),
  };

  const run = deps.runWorkflow ?? runDiscussToPr;
  const result = await run(input, wiring.deps);
  // redo で同じ参加者を復元できるよう Run に保存する。
  await saveParticipantOverride(wiring.deps.discussion.runStore, result.runId, participantOverride).catch(() => undefined);

  if (result.status === "awaiting_human") {
    stdout(`Run ID: ${result.runId}\n`);
    if (result.conclusion !== undefined) {
      stdout(`結論: ${result.conclusion.conclusion}\n`);
    }
    stdout(
      `\n承認すると specify 以降（plan → implement → verify → review → publish）へ進みます。\n` +
        `Next: meguribi approve ${result.runId}  /  meguribi reject ${result.runId} --reason "..." [--redo]\n`,
    );
    return { exitCode: 0 };
  }
  if (result.status === "completed") {
    stdout(`議論は完了しました: ${result.runId}\n`);
    return { exitCode: 0 };
  }
  stderr(`discuss-to-pr は ${result.status} で終了しました: ${result.runId}\n`);
  for (const reason of result.reasons) {
    stderr(`- ${reason}\n`);
  }
  return { exitCode: 1 };
}
