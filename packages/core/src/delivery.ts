import type { PlanArtifact, PlanContent, ReviewArtifact } from "./codex-artifact.js";
import type {
  DevinAdapter,
  FixInput,
  ImplementationInput,
  ImplementationResult,
} from "./devin-adapter.js";
import type { InheritedMcpPolicy } from "./inherited-mcp-policy.js";

export type RunCommand = "run" | "resume";

/**
 * Coarse run lifecycle. Fine-grained ACP steps live in currentStep / completedSteps.
 */
export type RunStatus =
  | "created"
  | "planning"
  | "planned"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "fixing"
  | "publishing"
  | "awaiting_human"
  | "blocked"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "timed_out";

/**
 * Delivery steps including ACP-centric checkpoints from Issue #22.
 */
export type DeliveryStep =
  | "context"
  | "preflight"
  | "awaiting_mcp_confirmation"
  | "worktree"
  | "planning"
  | "implementing"
  | "implementation_completed"
  | "implementation_blocked"
  | "cancelling"
  | "cancelled"
  | "timed_out"
  | "verifying"
  | "reviewing"
  | "fixing"
  | "publishing"
  | "awaiting_human";

export interface RunIdentity {
  repository: string;
  issueNumber: number;
  branch: string;
  worktreePath: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  remoteIdentity: string;
}

export interface RunState {
  schemaVersion: 1;
  runId: string;
  repository: string;
  issueNumber: number;
  command: RunCommand;
  status: RunStatus;
  currentStep?: DeliveryStep;
  completedSteps: DeliveryStep[];
  branch: string;
  worktreePath: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  remoteIdentity: string;
  pullRequestNumber: number | null;
  agentSessions: {
    codexPlan?: string;
    devinImplementation?: string;
    codexReview?: string;
  };
  fixAttempts: number;
  maxFixAttempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: {
    code: string;
    message: string;
  };
}

export interface IssueRecord {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
  comments: readonly { id: number; author: string; body: string }[];
  updatedAt: string;
}

export interface VerificationCommandResult {
  name: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  logPath?: string;
  timedOut?: boolean;
}

export interface VerificationResult {
  schemaVersion: 1;
  artifactType: "verification";
  success: boolean;
  commands: VerificationCommandResult[];
}

export interface VerificationLogWriter {
  write(input: {
    commandName: string;
    commandIndex: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
  }): Promise<string>;
}

export interface PublishDecision {
  allowed: boolean;
  reasons: readonly string[];
}

export interface GitHubAdapter {
  getIssue(repository: string, issueNumber: number): Promise<IssueRecord>;
  upsertMarkerComment(input: {
    repository: string;
    issueNumber: number;
    marker: string;
    body: string;
  }): Promise<{ commentId: number }>;
  createDraftPullRequest(input: {
    repository: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ number: number; url: string }>;
  findDraftPullRequest(input: {
    repository: string;
    head: string;
  }): Promise<{ number: number; url: string } | null>;
}

export interface GitAdapter {
  ensureWorktree(input: {
    repositoryPath: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
  }): Promise<{ baseSha: string; headSha: string; remoteIdentity: string }>;
  getIdentity(worktreePath: string): Promise<{
    branch: string;
    headSha: string;
    remoteIdentity: string;
  }>;
  getDiff(worktreePath: string): Promise<{ changedFiles: string[]; patch: string }>;
  commit(input: {
    worktreePath: string;
    paths: readonly string[];
    message: string;
  }): Promise<{ headSha: string }>;
  push(input: { worktreePath: string; branch: string }): Promise<void>;
}

export interface Verifier {
  verify(input: {
    worktreePath: string;
    commands: readonly { name: string; run: string }[];
    abortSignal?: AbortSignal;
    /** Per-command timeout; adapters must fail closed when exceeded. */
    timeoutMs?: number;
    logWriter?: VerificationLogWriter;
  }): Promise<VerificationResult>;
}

export interface PolicyEngine {
  assertReady(input: {
    labels: readonly string[];
    requiredLabels: readonly string[];
    nonInteractive: boolean;
  }): Promise<void>;
  evaluatePublish(input: {
    implementation: ImplementationResult;
    verification: VerificationResult;
    reviewStatus: ReviewArtifact["status"];
    protectedPaths: readonly string[];
  }): Promise<PublishDecision>;
}

export interface RunStore {
  create(input: {
    repository: string;
    issueNumber: number;
    command: RunCommand;
    identity: RunIdentity;
    maxFixAttempts: number;
  }): Promise<RunState>;
  load(runId: string): Promise<RunState | null>;
  loadLatest(repository: string, issueNumber: number): Promise<RunState | null>;
  update(runId: string, patch: Partial<RunState>): Promise<RunState>;
  saveArtifact(runId: string, name: string, value: unknown): Promise<string>;
  readArtifact<T>(runId: string, name: string): Promise<T | null>;
  acquireLock(input: {
    repository: string;
    issueNumber: number;
    runId: string;
  }): Promise<void>;
  releaseLock(input: {
    repository: string;
    issueNumber: number;
  }): Promise<void>;
}

export interface DeliveryMcpConfirmation {
  confirmInheritedMcp(): Promise<boolean>;
}

export interface DeliveryDependencies {
  github: GitHubAdapter;
  git: GitAdapter;
  codex: {
    createPlan(input: {
      repositoryPath: string;
      issue: IssueRecord;
      repositoryRules: string;
      completionCriteria: string[];
      outOfScope: string[];
    }): Promise<PlanArtifact>;
    review(input: {
      repositoryPath: string;
      issue: IssueRecord;
      plan: PlanContent;
      diff: string;
      changedFiles: string[];
      verification: VerificationResult;
      repositoryRules: string;
    }): Promise<ReviewArtifact>;
  };
  devin: DevinAdapter;
  verifier: Verifier;
  policy: PolicyEngine;
  runStore: RunStore;
  mcpConfirmation?: DeliveryMcpConfirmation;
  /** Optional Devin CLI readiness check before implementation. */
  assertDevinReady?: () => Promise<void>;
  now?: () => Date;
}

export interface RunDeliveryInput {
  repository: string;
  issueNumber: number;
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  repositoryRules: string;
  completionCriteria: string[];
  outOfScope: string[];
  requiredLabels: readonly string[];
  protectedPaths: readonly string[];
  verifyCommands: readonly { name: string; run: string }[];
  inheritedMcpPolicy: InheritedMcpPolicy;
  allowInheritedMcp: boolean;
  nonInteractive: boolean;
  maxFixAttempts: number;
  artifactRootForDevin: string;
  abortSignal?: AbortSignal;
  /** Per verify-command timeout in milliseconds. */
  verifyTimeoutMs?: number;
  noCommit?: boolean;
  noPush?: boolean;
  noPr?: boolean;
}

export interface ResumeDeliveryInput {
  repository: string;
  issueNumber: number;
  runId?: string;
  repositoryPath: string;
  repositoryRules: string;
  protectedPaths: readonly string[];
  verifyCommands: readonly { name: string; run: string }[];
  nonInteractive: boolean;
  allowInheritedMcp: boolean;
  inheritedMcpPolicy: InheritedMcpPolicy;
  artifactRootForDevin: string;
  abortSignal?: AbortSignal;
  /** Per verify-command timeout in milliseconds. */
  verifyTimeoutMs?: number;
  noCommit?: boolean;
  noPush?: boolean;
  noPr?: boolean;
}

export interface DeliveryResult {
  runId: string;
  status: RunStatus;
  implementation?: ImplementationResult;
  verification?: VerificationResult;
  review?: ReviewArtifact;
  pullRequestNumber?: number | null;
  published: boolean;
  reasons: readonly string[];
}

export type { DevinAdapter, FixInput, ImplementationInput, ImplementationResult };
