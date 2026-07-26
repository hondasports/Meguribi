import type { PlanArtifact, PlanContent, ReviewArtifact } from "@meguribi/core";

export interface CodexThreadEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexThread {
  readonly id: string | null;
  runStreamed(
    input: string,
    options: { outputSchema: unknown; signal: AbortSignal },
  ): Promise<{ events: AsyncIterable<CodexThreadEvent> }>;
}

export interface CodexThreadOptions {
  workingDirectory: string;
  sandboxMode: "read-only";
  networkAccessEnabled: false;
  webSearchEnabled: false;
  approvalPolicy: "never";
}

export interface CodexClient {
  startThread(options: CodexThreadOptions): CodexThread;
  resumeThread(threadId: string, options: CodexThreadOptions): CodexThread;
}

export interface CodexIssueContext {
  title: string;
  body: string;
  comments: string[];
}

export interface CodexWorkspaceGuard {
  snapshot(): Promise<string>;
}

export interface PlanningInput {
  repositoryPath: string;
  issue: CodexIssueContext;
  repositoryRules: string;
  productContext?: string;
  completionCriteria: string[];
  outOfScope: string[];
  sourceDigests: Record<string, string>;
  workspaceGuard: CodexWorkspaceGuard;
  threadId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface VerificationSummary {
  success: boolean;
  commands: Array<{ name: string; exitCode: number | null }>;
}

export interface ReviewInput {
  repositoryPath: string;
  issue: CodexIssueContext;
  plan: PlanContent;
  diff: string;
  changedFiles: string[];
  verification: VerificationSummary;
  repositoryRules: string;
  sourceDigests: Record<string, string>;
  workspaceGuard: CodexWorkspaceGuard;
  threadId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface CodexAdapterOptions {
  client: CodexClient;
  defaultTimeoutMs?: number;
  maxRepairAttempts?: 0 | 1;
  now?: () => Date;
  idFactory?: () => string;
}

export interface CodexAdapter {
  createPlan(input: PlanningInput): Promise<PlanArtifact>;
  review(input: ReviewInput): Promise<ReviewArtifact>;
}
