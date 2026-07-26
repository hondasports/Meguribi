import type { AgentEvent, AgentTerminationReason, AgentTerminationResult, ImplementationContext } from "@meguribi/core";
import {
  DevinAgentArtifactStore,
  type DevinPromptArtifact,
  type DevinAgentResultArtifact,
} from "./artifact-store.js";
import {
  normalizePermissionRequest,
  normalizeSessionStarted,
  normalizeSessionUpdate,
  normalizeTurnCompleted,
  type AcpSessionUpdatePayload,
} from "./events.js";
import {
  createDevinAcpTransport,
  type DevinAcpConnection,
  type DevinAcpTransport,
  type RawDevinAcpEvent,
  type StartDevinAcpInput,
} from "./transport.js";
import { DevinAcpTransportError } from "./transport-error.js";
import { DevinAcpShutdownController, type ShutdownOptions } from "./shutdown.js";
import type { PermissionMediator } from "./permissions.js";
import { buildDevinPrompt } from "./prompt.js";
import {
  captureGitWorktreeSnapshot,
  compareGitWorktreeSnapshots,
  type GitSafetyComparison,
  type GitSafetyComparisonInput,
  type GitWorktreeSnapshot,
} from "../git-boundary.js";

export type DevinGitBoundaryConfig = Omit<GitSafetyComparisonInput, "before" | "after"> & {
  expectedRemoteIdentity: string;
  /**
   * `approved-base` ignores Meguribi-owned dirty files present at session start.
   * Use for fix turns that begin after a completed implementation.
   */
  baselineMode?: "session-start" | "approved-base";
};

export interface StartDevinAcpSessionInput extends StartDevinAcpInput {
  artifactRoot: string;
  transport?: DevinAcpTransport;
  implementationContext?: ImplementationContext;
  gitBoundary?: DevinGitBoundaryConfig;
}

export interface DevinAcpSession {
  readonly sessionId: string;
  readonly protocolVersion: number;
  readonly artifacts: DevinAgentArtifactStore;
  prompt(input?: { content?: string }): AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  closeInput(): Promise<void>;
  finish(result: DevinAgentResultArtifact): Promise<void>;
  shutdown(reason: AgentTerminationReason, options: ShutdownOptions): Promise<AgentTerminationResult>;
  terminate(graceMs?: number): Promise<void>;
  validateGitBoundary(reportedFiles?: readonly string[]): Promise<GitSafetyComparison | undefined>;
}

async function* mapRawEvents(
  rawEvents: AsyncIterable<RawDevinAcpEvent>,
  artifacts: DevinAgentArtifactStore,
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

class DevinAcpSessionImpl implements DevinAcpSession {
  private stderrPersisted = false;

  constructor(
    readonly sessionId: string,
    readonly protocolVersion: number,
    readonly artifacts: DevinAgentArtifactStore,
    private readonly connection: DevinAcpConnection,
    private readonly cwd: string,
    private readonly startedAt: string,
    private readonly shutdownController: DevinAcpShutdownController,
    private readonly permissionMediator?: PermissionMediator,
    private readonly promptArtifact?: DevinPromptArtifact,
    private readonly gitBoundaryConfig?: DevinGitBoundaryConfig,
    private readonly gitBoundaryBefore?: GitWorktreeSnapshot,
  ) {}

  private gitBoundaryResultPromise: Promise<GitSafetyComparison | undefined> | undefined;

  async *prompt(input: { content?: string } = {}): AsyncIterable<AgentEvent> {
    const content = this.promptArtifact?.content ?? input.content;
    if (!content || content.trim().length === 0) {
      throw new DevinAcpTransportError(
        "protocol_violation",
        "ACP prompt requires built implementationContext or explicit content",
      );
    }
    try {
      yield* mapRawEvents(this.connection.prompt({
        content,
      }), this.artifacts, {
        cwd: this.cwd,
        protocolVersion: this.protocolVersion,
        startedAt: this.startedAt,
      });
      await this.shutdown("completed", { gracefulShutdownMs: 1, terminateTimeoutMs: 1_000 });
    } catch (error) {
      const agentError =
        error instanceof DevinAcpTransportError
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

  async finish(result: DevinAgentResultArtifact): Promise<void> {
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

export async function startDevinAcpSession(
  input: StartDevinAcpSessionInput,
): Promise<DevinAcpSession> {
  const artifacts = new DevinAgentArtifactStore(input.artifactRoot);
  await artifacts.init();
  const promptArtifact = input.implementationContext
    ? buildDevinPrompt(input.implementationContext)
    : undefined;
  if (promptArtifact) {
    await artifacts.writePrompt(promptArtifact);
  }
  const gitBoundaryBefore = input.gitBoundary
    ? await captureGitWorktreeSnapshot({
      cwd: input.cwd,
      outsidePaths: input.gitBoundary.outsidePaths,
      baseSha: input.gitBoundary.expectedBaseSha,
    })
    : undefined;

  const transport = input.transport ?? createDevinAcpTransport();
  const connection = await transport.start(input);
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

  return new DevinAcpSessionImpl(
    connection.sessionId,
    connection.protocolVersion,
    artifacts,
    connection,
    input.cwd,
    startedAt,
    new DevinAcpShutdownController(connection),
    input.permissionMediator,
    promptArtifact,
    input.gitBoundary,
    gitBoundaryBefore,
  );
}

function terminationReason(error: unknown): AgentTerminationReason {
  if (error instanceof DevinAcpTransportError) {
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
