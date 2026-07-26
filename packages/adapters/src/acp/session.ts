import type {
  AgentEvent,
  AgentTerminationReason,
  AgentTerminationResult,
} from "@meguribi/core";
import {
  normalizePermissionRequest,
  normalizeSessionStarted,
  normalizeSessionUpdate,
  normalizeTurnCompleted,
  type AcpSessionUpdatePayload,
} from "./events.js";
import {
  createAcpTransport,
  type AcpConnection,
  type AcpTransport,
  type RawAcpEvent,
  type StartAcpInput,
} from "./transport.js";
import { AcpTransportError } from "./transport-error.js";
import { AcpShutdownController, type ShutdownOptions } from "./shutdown.js";
import type { PermissionMediator } from "./permissions.js";
import {
  captureGitWorktreeSnapshot,
  compareGitWorktreeSnapshots,
  type GitSafetyComparison,
  type GitSafetyComparisonInput,
  type GitWorktreeSnapshot,
} from "../git-boundary.js";

export interface AcpAgentSessionMetadata {
  sessionId: string;
  cwd: string;
  protocolVersion?: number;
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface AcpAgentResultArtifact {
  status: "completed" | "failed" | "cancelled" | "blocked";
  sessionId: string;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  reportedFiles?: readonly string[];
}

export interface AcpPromptArtifact {
  version: string;
  hash: string;
  content: string;
}

export interface AcpGitBoundaryArtifact {
  verdict: "allowed" | "blocked" | "suspicious";
  publishable: boolean;
  reasons: readonly string[];
  warnings: readonly string[];
  changedFiles: readonly string[];
  preExistingDirty: boolean;
}

export interface PersistedAgentEvent {
  sequence: number;
  at: string;
  event: AgentEvent;
}

export interface PersistedRawEvent {
  sequence: number;
  at: string;
  kind: string;
  raw: unknown;
}

/**
 * Filesystem-facing artifact store contract used by the generic ACP session.
 */
export interface AcpArtifactStore {
  readonly root: string;
  readonly rawEventsPath: string;
  readonly eventsPath: string;
  readonly stderrPath: string;
  readonly sessionPath: string;
  readonly resultPath: string;
  readonly promptPath: string;
  readonly promptMetadataPath: string;
  readonly gitBoundaryPath: string;
  readonly terminationPath: string;

  nextSequence(): number;
  init(): Promise<void>;
  appendRaw(
    kind: string,
    raw: unknown,
    sequence: number,
    at?: string,
  ): Promise<PersistedRawEvent>;
  appendEvent(
    event: AgentEvent,
    sequence: number,
    at?: string,
  ): Promise<PersistedAgentEvent>;
  appendStderr(chunk: string): Promise<void>;
  writeSession(metadata: AcpAgentSessionMetadata): Promise<void>;
  writeResult(result: AcpAgentResultArtifact): Promise<void>;
  writePrompt(prompt: AcpPromptArtifact): Promise<void>;
  writeGitBoundary(result: AcpGitBoundaryArtifact): Promise<void>;
  writeTermination(result: AgentTerminationResult): Promise<void>;
}

export type AcpGitBoundaryConfig = Omit<GitSafetyComparisonInput, "before" | "after"> & {
  expectedRemoteIdentity: string;
  /**
   * `approved-base` ignores Meguribi-owned dirty files present at session start.
   * Use for fix turns that begin after a completed implementation.
   */
  baselineMode?: "session-start" | "approved-base";
};

export interface StartAcpSessionInput extends StartAcpInput {
  artifactRoot: string;
  createArtifactStore(root: string): AcpArtifactStore;
  promptArtifact?: AcpPromptArtifact;
  gitBoundary?: AcpGitBoundaryConfig;
  transport?: AcpTransport;
}

export interface AcpSession {
  readonly sessionId: string;
  readonly protocolVersion: number;
  readonly artifacts: AcpArtifactStore;
  prompt(input?: { content?: string }): AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  closeInput(): Promise<void>;
  finish(result: AcpAgentResultArtifact): Promise<void>;
  shutdown(reason: AgentTerminationReason, options: ShutdownOptions): Promise<AgentTerminationResult>;
  terminate(graceMs?: number): Promise<void>;
  validateGitBoundary(reportedFiles?: readonly string[]): Promise<GitSafetyComparison | undefined>;
}

async function* mapRawEvents(
  rawEvents: AsyncIterable<RawAcpEvent>,
  artifacts: AcpArtifactStore,
  sessionMeta: { cwd: string; protocolVersion: number; startedAt: string },
): AsyncIterable<AgentEvent> {
  for await (const raw of rawEvents) {
    const sequence = artifacts.nextSequence();
    if (raw.kind === "session_update") {
      await artifacts.appendRaw("session_update", raw.update, sequence, raw.at);
      const normalized = normalizeSessionUpdate(
        {
          sessionId: raw.sessionId,
          update: raw.update as AcpSessionUpdatePayload,
        },
        raw.at,
      );
      for (const event of normalized) {
        const persisted = await artifacts.appendEvent(event, sequence, raw.at);
        yield persisted.event;
      }
      continue;
    }

    if (raw.kind === "permission_request") {
      await artifacts.appendRaw("permission_request", raw.raw, sequence, raw.at);
      const event = normalizePermissionRequest({
        sessionId: raw.sessionId,
        requestId: raw.requestId,
        summary: raw.summary,
        decision: raw.decision,
        at: raw.at,
      });
      const persisted = await artifacts.appendEvent(event, sequence, raw.at);
      yield persisted.event;
      continue;
    }

    if (raw.kind === "turn_completed") {
      await artifacts.appendRaw(
        "turn_completed",
        { stopReason: raw.stopReason },
        sequence,
        raw.at,
      );
      const event = normalizeTurnCompleted({
        sessionId: raw.sessionId,
        stopReason: raw.stopReason,
        at: raw.at,
      });
      const persisted = await artifacts.appendEvent(event, sequence, raw.at);
      await artifacts.writeSession({
        sessionId: raw.sessionId,
        cwd: sessionMeta.cwd,
        protocolVersion: sessionMeta.protocolVersion,
        stopReason: raw.stopReason,
        startedAt: sessionMeta.startedAt,
        finishedAt: raw.at,
      });
      yield persisted.event;
    }
  }
}

class AcpSessionImpl implements AcpSession {
  private stderrPersisted = false;

  constructor(
    readonly sessionId: string,
    readonly protocolVersion: number,
    readonly artifacts: AcpArtifactStore,
    private readonly connection: AcpConnection,
    private readonly cwd: string,
    private readonly startedAt: string,
    private readonly shutdownController: AcpShutdownController,
    private readonly permissionMediator?: PermissionMediator,
    private readonly promptArtifact?: AcpPromptArtifact,
    private readonly gitBoundaryConfig?: AcpGitBoundaryConfig,
    private readonly gitBoundaryBefore?: GitWorktreeSnapshot,
  ) {}

  private gitBoundaryResultPromise: Promise<GitSafetyComparison | undefined> | undefined;
  private shutdownPromise: Promise<AgentTerminationResult> | undefined;

  async *prompt(input: { content?: string } = {}): AsyncIterable<AgentEvent> {
    const content = this.promptArtifact?.content ?? input.content;
    if (!content || content.trim().length === 0) {
      throw new AcpTransportError(
        "protocol_violation",
        "ACP prompt requires built implementationContext or explicit content",
      );
    }
    try {
      yield* mapRawEvents(this.connection.prompt({ content }), this.artifacts, {
        cwd: this.cwd,
        protocolVersion: this.protocolVersion,
        startedAt: this.startedAt,
      });
      await this.shutdown("completed", { gracefulShutdownMs: 1, terminateTimeoutMs: 1_000 });
    } catch (error) {
      const agentError =
        error instanceof AcpTransportError
          ? error.toAgentError()
          : {
              code: "unknown" as const,
              message: error instanceof Error ? error.message : "ACP prompt failed",
              isRetryable: false,
            };
      const failed: AgentEvent = {
        type: "session.failed",
        sessionId: this.sessionId,
        error: agentError,
        at: new Date().toISOString(),
      };
      const sequence = this.artifacts.nextSequence();
      await this.artifacts.appendEvent(failed, sequence);
      const mcpAlert = this.connection.mcpSecurityAlert();
      if (mcpAlert) {
        await this.artifacts.appendStderr(mcpAlert);
      }
      await this.shutdown(terminationReason(error), {
        gracefulShutdownMs: 50,
        terminateTimeoutMs: 1_000,
      }).catch(() => undefined);
      await this.persistStderr();
      throw error;
    } finally {
      // Closing an async generator early must not leave the ACP process alive.
      await this.shutdown("cancelled", { gracefulShutdownMs: 50, terminateTimeoutMs: 1_000 }).catch(() => undefined);
    }
  }

  async cancel(): Promise<void> {
    await this.shutdown("cancelled", { gracefulShutdownMs: 50, terminateTimeoutMs: 1_000 });
  }

  closeInput(): Promise<void> {
    return this.connection.closeInput();
  }

  async finish(result: AcpAgentResultArtifact): Promise<void> {
    await this.artifacts.writeSession({
      sessionId: this.sessionId,
      cwd: this.cwd,
      protocolVersion: this.protocolVersion,
      stopReason: result.stopReason,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
    });
    const boundary = await this.validateGitBoundary(result.reportedFiles);
    if (boundary && !boundary.publishable) {
      const blocked = {
        ...result,
        status: "blocked" as const,
        errorCode: "policy_blocked",
        errorMessage: "Git/worktree safety boundary blocked publishing",
      };
      await this.artifacts.writeResult(blocked);
      await this.persistStderr();
      throw new Error("Git/worktree safety boundary blocked publishing");
    }
    await this.artifacts.writeResult(result);
    await this.persistStderr();
  }

  async terminate(graceMs?: number): Promise<void> {
    await this.shutdown("completed", {
      gracefulShutdownMs: 1,
      terminateTimeoutMs: graceMs ?? 1_000,
    });
  }

  async shutdown(reason: AgentTerminationReason, options: ShutdownOptions): Promise<AgentTerminationResult> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.performShutdown(reason, options);
    }
    return this.shutdownPromise;
  }

  private async performShutdown(
    reason: AgentTerminationReason,
    options: ShutdownOptions,
  ): Promise<AgentTerminationResult> {
    const result = await this.shutdownController.shutdown(reason, options);
    this.permissionMediator?.endSession(this.sessionId);
    await this.validateGitBoundary();
    await this.artifacts.writeTermination(result);
    await this.persistStderr();
    return result;
  }

  async validateGitBoundary(reportedFiles?: readonly string[]): Promise<GitSafetyComparison | undefined> {
    if (reportedFiles && this.gitBoundaryConfig && this.gitBoundaryBefore) {
      try {
        const after = await captureGitWorktreeSnapshot({
          cwd: this.cwd,
          outsidePaths: this.gitBoundaryConfig.outsidePaths,
          baseSha: this.gitBoundaryConfig.expectedBaseSha,
        });
        const { baselineMode, ...compareConfig } = this.gitBoundaryConfig;
        const comparison = await compareGitWorktreeSnapshots({
          ...compareConfig,
          before: toComparisonBefore(this.gitBoundaryBefore, baselineMode),
          after,
          reportedFiles,
        });
        await this.artifacts.writeGitBoundary(comparison);
        this.gitBoundaryResultPromise = Promise.resolve(comparison);
        return comparison;
      } catch {
        const comparison: GitSafetyComparison = {
          verdict: "suspicious",
          publishable: false,
          reasons: ["Git/worktree snapshot validation failed"],
          warnings: [],
          changedFiles: [],
          preExistingDirty: this.gitBoundaryBefore.dirty,
        };
        await this.artifacts.writeGitBoundary(comparison);
        this.gitBoundaryResultPromise = Promise.resolve(comparison);
        return comparison;
      }
    }
    if (!this.gitBoundaryResultPromise) {
      if (!this.gitBoundaryConfig || !this.gitBoundaryBefore) {
        this.gitBoundaryResultPromise = captureGitWorktreeSnapshot({ cwd: this.cwd }).then(async (snapshot) => {
          const comparison: GitSafetyComparison = {
            verdict: "suspicious",
            publishable: false,
            reasons: ["Git safety boundary configuration is required for repository execution"],
            warnings: [],
            changedFiles: snapshot.changedFiles,
            preExistingDirty: snapshot.dirty,
          };
          await this.artifacts.writeGitBoundary(comparison);
          return comparison;
        }).catch(() => undefined);
        return this.gitBoundaryResultPromise;
      }
      this.gitBoundaryResultPromise = captureGitWorktreeSnapshot({
        cwd: this.cwd,
        outsidePaths: this.gitBoundaryConfig.outsidePaths,
        baseSha: this.gitBoundaryConfig.expectedBaseSha,
      }).then((after) => {
        const { baselineMode, ...compareConfig } = this.gitBoundaryConfig!;
        return compareGitWorktreeSnapshots({
          ...compareConfig,
          before: toComparisonBefore(this.gitBoundaryBefore!, baselineMode),
          after,
        });
      }).then(async (comparison) => {
        await this.artifacts.writeGitBoundary(comparison);
        return comparison;
      }).catch(async () => {
        const comparison: GitSafetyComparison = {
          verdict: "suspicious",
          publishable: false,
          reasons: ["Git/worktree snapshot validation failed"],
          warnings: [],
          changedFiles: [],
          preExistingDirty: this.gitBoundaryBefore?.dirty ?? true,
        };
        await this.artifacts.writeGitBoundary(comparison);
        return comparison;
      });
    }
    return this.gitBoundaryResultPromise;
  }

  private async persistStderr(): Promise<void> {
    if (this.stderrPersisted) {
      return;
    }
    this.stderrPersisted = true;
    await this.connection.awaitStderrDrain(1_000);
    const stderr = this.connection.stderrText();
    if (stderr.length > 0) {
      await this.artifacts.appendStderr(stderr);
    }
  }
}

export async function startAcpSession(
  input: StartAcpSessionInput,
): Promise<AcpSession> {
  const {
    artifactRoot,
    createArtifactStore,
    promptArtifact,
    gitBoundary,
    transport: transportOverride,
    ...transportInput
  } = input;

  const artifacts = createArtifactStore(artifactRoot);
  await artifacts.init();
  if (promptArtifact) {
    await artifacts.writePrompt(promptArtifact);
  }
  const gitBoundaryBefore = gitBoundary
    ? await captureGitWorktreeSnapshot({
      cwd: input.cwd,
      outsidePaths: gitBoundary.outsidePaths,
      baseSha: gitBoundary.expectedBaseSha,
    })
    : undefined;

  const transport = transportOverride ?? createAcpTransport();
  const connection = await transport.start(transportInput);
  const startedAt = new Date().toISOString();
  const started = normalizeSessionStarted(connection.sessionId, startedAt);
  const sequence = artifacts.nextSequence();
  await artifacts.appendEvent(started, sequence, startedAt);
  await artifacts.writeSession({
    sessionId: connection.sessionId,
    cwd: input.cwd,
    protocolVersion: connection.protocolVersion,
    startedAt,
  });
  const mcpWarning = connection.mcpWarning();
  if (mcpWarning) {
    await artifacts.appendStderr(`WARN: ${mcpWarning}\n`);
  }

  return new AcpSessionImpl(
    connection.sessionId,
    connection.protocolVersion,
    artifacts,
    connection,
    input.cwd,
    startedAt,
    new AcpShutdownController(connection),
    input.permissionMediator,
    promptArtifact,
    gitBoundary,
    gitBoundaryBefore,
  );
}

function terminationReason(error: unknown): AgentTerminationReason {
  if (error instanceof AcpTransportError) {
    if (error.code === "cancelled") return "cancelled";
    if (error.code === "startup_timeout" || error.code === "turn_timeout") return "timed_out";
    if (error.code === "process_crashed" || error.code === "connection_closed") return "crashed";
    if (error.code === "policy_blocked" || error.code === "malformed_message" || error.code === "protocol_violation") {
      return "protocol_error";
    }
  }
  return "protocol_error";
}

function toComparisonBefore(
  before: GitWorktreeSnapshot,
  baselineMode: "session-start" | "approved-base" | undefined,
): GitWorktreeSnapshot {
  if (baselineMode !== "approved-base") {
    return before;
  }
  // Fix sessions start on a Meguribi-owned dirty worktree. Compare against a
  // clean identity baseline so implement files are authoritative for publish.
  return {
    ...before,
    dirty: false,
    statusEntries: {},
    fileDigests: {},
    changedFiles: [],
    diffLines: 0,
    hasBinary: false,
    oversized: false,
  };
}
