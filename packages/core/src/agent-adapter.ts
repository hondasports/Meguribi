import type { AgentError } from "./agent-error.js";
import type { AgentTerminationResult } from "./agent-termination.js";
import type { ImplementationContext } from "./implementation-context.js";
import type { InheritedMcpPolicy } from "./inherited-mcp-policy.js";
import type { McpPolicyDecision } from "./mcp-policy.js";

/**
 * Authoritative Git/worktree safety inputs for an implementation turn.
 * Adapter-specific runners stay outside this port.
 */
export interface ImplementationGitBoundary {
  expectedRemoteIdentity: string;
  expectedBaseSha: string;
  expectedBranch: string;
  outsidePaths: readonly string[];
  protectedPaths: readonly string[];
  maxChangedFiles: number;
  maxDiffLines: number;
}

export interface ImplementationInput {
  context: ImplementationContext;
  artifactRoot: string;
  gitBoundary: ImplementationGitBoundary;
  abortSignal?: AbortSignal;
}

export interface FixInput extends ImplementationInput {
  /**
   * Optional digest of the previous attempt for resume identity checks.
   * Mid-session ACP resume is not guaranteed; adapters may start a new session.
   */
  previousSessionId?: string;
}

export type ImplementationStatus =
  | "completed"
  | "blocked"
  | "cancelled"
  | "timed_out"
  | "failed";

export interface ImplementationPermissionDecision {
  requestId: string;
  outcome: "approve" | "deny" | "confirm";
  reason: string;
}

export interface ImplementationArtifactPaths {
  root: string;
  rawEvents?: string;
  events?: string;
  result?: string;
  gitBoundary?: string;
  termination?: string;
  prompt?: string;
  stderr?: string;
}

/**
 * Normalized agent implementation outcome.
 * Git-authoritative changedFiles are the source of truth for publish gates.
 */
export interface ImplementationResult {
  status: ImplementationStatus;
  sessionId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stopReason?: string;
  changedFiles: readonly string[];
  reportedFiles: readonly string[];
  unresolvedItems: readonly string[];
  permissionDecisions: readonly ImplementationPermissionDecision[];
  mcpPolicyResult?: McpPolicyDecision;
  termination?: AgentTerminationResult;
  artifactPaths: ImplementationArtifactPaths;
  promptVersion?: string;
  promptHash?: string;
  publishable: boolean;
  error?: AgentError;
  secondaryError?: AgentError;
}

export interface AgentAdapter {
  implement(input: ImplementationInput): Promise<ImplementationResult>;
  fix(input: FixInput): Promise<ImplementationResult>;
}

export type { InheritedMcpPolicy };
