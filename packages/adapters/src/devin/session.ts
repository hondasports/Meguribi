import type { AgentEvent } from "@meguribi/core";
import {
  DevinAgentArtifactStore,
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

export interface StartDevinAcpSessionInput extends StartDevinAcpInput {
  artifactRoot: string;
  transport?: DevinAcpTransport;
}

export interface DevinAcpSession {
  readonly sessionId: string;
  readonly protocolVersion: number;
  readonly artifacts: DevinAgentArtifactStore;
  prompt(input: { content: string }): AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  closeInput(): Promise<void>;
  finish(result: DevinAgentResultArtifact): Promise<void>;
  terminate(graceMs?: number): Promise<void>;
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
  ) {}

  async *prompt(input: { content: string }): AsyncIterable<AgentEvent> {
    try {
      yield* mapRawEvents(this.connection.prompt(input), this.artifacts, {
        cwd: this.cwd,
        protocolVersion: this.protocolVersion,
        startedAt: this.startedAt,
      });
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
      await this.persistStderr();
      throw error;
    }
  }

  cancel(): Promise<void> {
    return this.connection.cancel();
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
    await this.artifacts.writeResult(result);
    await this.persistStderr();
  }

  async terminate(graceMs?: number): Promise<void> {
    await this.connection.terminate(graceMs);
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

  return new DevinAcpSessionImpl(
    connection.sessionId,
    connection.protocolVersion,
    artifacts,
    connection,
    input.cwd,
    startedAt,
  );
}
