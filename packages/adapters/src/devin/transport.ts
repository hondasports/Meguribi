import * as acp from "@agentclientprotocol/sdk";
import type { DevinDiagnosis } from "@meguribi/core";
import { ProcessRunner, type ManagedProcess, type ProcessExit } from "@meguribi/process";
import { assertDevinRunnable } from "./diagnose.js";
import {
  DevinAcpTransportError,
  toDevinAcpTransportError,
} from "./transport-error.js";
import {
  normalizeAcpPermissionRequest,
  toAcpPermissionResponse,
  type PermissionMediator,
} from "./permissions.js";
import {
  createMcpPolicyMonitor,
  type McpPolicyInput,
  type McpPolicyMonitor,
} from "./mcp.js";

/**
 * How long a turn stays open against the session process lifecycle after ACP
 * reports end_turn, before `turn_completed` is committed. Unexpected process
 * exit during this window is `process_crashed` (fail-fast when exit is earlier).
 *
 * This is not shutdown grace; it binds turn completion to process liveness on
 * the same lifecycle watcher that runs from spawn until intentional terminate.
 */
export const DEFAULT_POST_TURN_LIVENESS_MS = 500;
export const DEFAULT_PROMPT_TIMEOUT_MS = 300_000;

export interface StartDevinAcpInput {
  executable: string;
  /**
   * Arguments inserted before the ACP args (e.g. fake script path for `node`).
   */
  executableArgs?: string[];
  /**
   * ACP argv. Defaults to `["acp"]`. Use `[]` when the executable itself is an ACP server.
   */
  acpArgs?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs: number;
  promptTimeoutMs?: number;
  /**
   * Session-lifecycle observation window after prompt response before committing
   * `turn_completed`. Defaults to {@link DEFAULT_POST_TURN_LIVENESS_MS}.
   */
  postTurnLivenessMs?: number;
  diagnosis: DevinDiagnosis;
  runner?: ProcessRunner;
  clientInfo?: { name: string; version: string };
  permissionMediator?: PermissionMediator;
  protectedPaths?: string[];
  mcpPolicy?: McpPolicyInput;
}

/**
 * Adapter-internal raw ACP event. Never export SDK types through this surface.
 */
export type RawDevinAcpEvent =
  | {
      kind: "session_update";
      sequence: number;
      at: string;
      sessionId: string;
      update: Record<string, unknown>;
    }
  | {
      kind: "permission_request";
      sequence: number;
      at: string;
      sessionId: string;
      requestId: string;
      summary: string;
      raw: Record<string, unknown>;
      decision?: { outcome: "approve" | "deny" | "confirm"; reason: string };
    }
  | {
      kind: "turn_completed";
      sequence: number;
      at: string;
      sessionId: string;
      stopReason?: string;
    };

export interface DevinAcpConnection {
  readonly sessionId: string;
  readonly protocolVersion: number;
  readonly stderrText: () => string;
  readonly mcpSecurityAlert: () => string | undefined;
  readonly mcpWarning: () => string | undefined;
  /**
   * Wait until stderr collection finishes or `timeoutMs` elapses.
   * Use before persisting stderr so late diagnostic lines are not lost.
   */
  awaitStderrDrain(timeoutMs?: number): Promise<void>;
  prompt(input: { content: string }): AsyncIterable<RawDevinAcpEvent>;
  cancel(): Promise<void>;
  closeInput(): Promise<void>;
  waitForProcessExit(timeoutMs?: number): Promise<ProcessExit>;
  terminate(graceMs?: number): Promise<ProcessExit>;
}

export interface DevinAcpTransport {
  start(input: StartDevinAcpInput): Promise<DevinAcpConnection>;
}

type LiveHandlers = {
  onSessionUpdate: (notification: acp.SessionNotification) => void;
  onPermission: (
    params: acp.RequestPermissionRequest,
  ) => acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse>;
};

/**
 * Process exit state for one ACP connection, from spawn until intentional terminate.
 */
export class AcpProcessLifecycle {
  private intentionalShutdown = false;
  private exitError: DevinAcpTransportError | undefined;
  private readonly listeners = new Set<(error: DevinAcpTransportError) => void>();

  constructor(processHandle: Pick<ManagedProcess, "waitForExit">) {
    void processHandle.waitForExit().then(
      (exit) => {
        this.recordUnexpected(
          new DevinAcpTransportError(
            "process_crashed",
            `ACP process exited unexpectedly (code=${exit.code}, signal=${exit.signal})`,
          ),
        );
      },
      (error: unknown) => {
        this.recordUnexpected(toDevinAcpTransportError(error, "spawn_failure"));
      },
    );
  }

  markIntentionalShutdown(): void {
    this.intentionalShutdown = true;
  }

  get unexpectedError(): DevinAcpTransportError | undefined {
    return this.intentionalShutdown ? undefined : this.exitError;
  }

  throwIfDead(): void {
    if (this.unexpectedError) {
      throw this.unexpectedError;
    }
  }

  onUnexpectedExit(listener: (error: DevinAcpTransportError) => void): () => void {
    if (this.unexpectedError) {
      listener(this.unexpectedError);
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Keep the active turn open against this session lifecycle until either the
   * process exits unexpectedly or `aliveWindowMs` elapses while still alive.
   * Crashes fail-fast (do not wait out the full window).
   */
  async awaitAliveOrCrash(aliveWindowMs: number): Promise<void> {
    if (aliveWindowMs <= 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.throwIfDead();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      // Initialize before onUnexpectedExit: already-exited processes notify
      // the listener synchronously and would otherwise hit a TDZ on const.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        unsubscribe?.();
        fn();
      };

      unsubscribe = this.onUnexpectedExit((error) => {
        finish(() => reject(error));
      });

      if (settled) {
        return;
      }

      timer = setTimeout(() => {
        finish(() => {
          try {
            this.throwIfDead();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }, aliveWindowMs);
    });
  }

  private recordUnexpected(error: DevinAcpTransportError): void {
    if (this.intentionalShutdown || this.exitError) {
      return;
    }
    this.exitError = error;
    for (const listener of this.listeners) {
      listener(error);
    }
  }
}

function asyncIterableToReadableStream(
  source: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      if (typeof iterator.return === "function") {
        await iterator.return(undefined);
      }
    },
  });
}

function managedStdinToWritableStream(processHandle: ManagedProcess): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      await processHandle.writeStdin(chunk);
    },
    async close() {
      await processHandle.closeStdin();
    },
    async abort() {
      await processHandle.closeStdin().catch(() => undefined);
    },
  });
}

async function collectStderr(
  processHandle: ManagedProcess,
  onChunk?: (chunk: string) => void,
): Promise<{ getText: () => string; done: Promise<void> }> {
  const chunks: string[] = [];
  const done = (async () => {
    for await (const chunk of processHandle.stderr) {
      const text = Buffer.from(chunk).toString("utf8");
      chunks.push(text);
      onChunk?.(text);
    }
  })();
  void done.catch(() => undefined);
  return {
    getText: () => chunks.join(""),
    done,
  };
}

async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  code: "startup_timeout" | "turn_timeout" = "startup_timeout",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new DevinAcpTransportError(
              code,
              `${label} timed out after ${timeoutMs}ms`,
              true,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

class DevinAcpConnectionImpl implements DevinAcpConnection {
  private sequence = 0;
  private closed = false;

  constructor(
    readonly sessionId: string,
    readonly protocolVersion: number,
    private readonly connection: acp.ClientSideConnection,
    private readonly processHandle: ManagedProcess,
    private readonly stderr: { getText: () => string; done: Promise<void> },
    private readonly handlers: LiveHandlers,
    private readonly lifecycle: AcpProcessLifecycle,
    private readonly postTurnLivenessMs: number,
    private readonly promptTimeoutMs: number,
    private readonly cwd: string,
    private readonly permissionMediator?: PermissionMediator,
    private readonly protectedPaths: string[] = [],
    private readonly mcpMonitor?: McpPolicyMonitor,
  ) {}

  stderrText(): string {
    return this.stderr.getText();
  }

  mcpSecurityAlert(): string | undefined {
    return this.mcpMonitor?.securityAlert();
  }

  mcpWarning(): string | undefined {
    return this.mcpMonitor?.warning();
  }

  async awaitStderrDrain(timeoutMs = 1_000): Promise<void> {
    await Promise.race([this.stderr.done, waitMs(timeoutMs)]);
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  async *prompt(input: { content: string }): AsyncIterable<RawDevinAcpEvent> {
    this.lifecycle.throwIfDead();
    const preflight = this.mcpMonitor ? await this.mcpMonitor.preflight() : undefined;
    if (preflight && preflight.outcome !== "allow") {
      throw new DevinAcpTransportError("policy_blocked", preflight.reason);
    }

    const queue: Array<RawDevinAcpEvent | { kind: "error"; error: DevinAcpTransportError }> = [];
    let wake: (() => void) | undefined;
    let settled = false;
    let stopReason: string | undefined;

    const push = (event: RawDevinAcpEvent | { kind: "error"; error: DevinAcpTransportError }) => {
      queue.push(event);
      wake?.();
    };

    const waitForItem = async () => {
      for (;;) {
        const next = queue.shift();
        if (next) {
          return next;
        }
        if (settled && queue.length === 0) {
          return undefined;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    };

    const unsubscribeExit = this.lifecycle.onUnexpectedExit((error) => {
      push({ kind: "error", error });
    });
    const unsubscribeMcp = this.mcpMonitor?.onDecision((decision) => {
      if (decision.outcome !== "allow") {
        push({ kind: "error", error: new DevinAcpTransportError("policy_blocked", decision.reason) });
      }
    });

    this.handlers.onSessionUpdate = (notification) => {
      const at = new Date().toISOString();
      const update = notification.update as unknown as Record<string, unknown>;
      this.mcpMonitor?.observe(JSON.stringify(update));
      push({
        kind: "session_update",
        sequence: this.nextSequence(),
        at,
        sessionId: notification.sessionId,
        update: {
          sessionUpdate: typeof update.sessionUpdate === "string" ? update.sessionUpdate : "unknown",
          ...update,
        },
      });
    };
    this.handlers.onPermission = async (params) => {
      const at = new Date().toISOString();
      const requestId = params.toolCall.toolCallId;
      const summary = params.toolCall.title ?? params.toolCall.name ?? "unknown tool";
      const normalized = normalizeAcpPermissionRequest(params, {
        cwd: this.cwd,
        protectedPaths: this.protectedPaths,
        rawArtifactRef: `raw-events.jsonl#${requestId}`,
      });
      const decision = this.permissionMediator
        ? await this.permissionMediator.decide(normalized)
        : { outcome: "deny" as const, reason: "no permission policy was provided" };
      push({
        kind: "permission_request",
        sequence: this.nextSequence(),
        at,
        sessionId: params.sessionId,
        requestId,
        summary,
        raw: params as unknown as Record<string, unknown>,
        decision,
      });
      return toAcpPermissionResponse(decision, params.options);
    };

    const promptCall = this.connection.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: input.content }],
      });
    const promptPromise = withTimeout(promptCall, this.promptTimeoutMs, "ACP prompt", "turn_timeout")
      .then((response) => {
        stopReason = response.stopReason;
        settled = true;
        wake?.();
      })
      .catch((error: unknown) => {
        settled = true;
        push({ kind: "error", error: toDevinAcpTransportError(error, "prompt_send_failure") });
        wake?.();
      });

    try {
      for (;;) {
        const item = await waitForItem();
        if (!item) {
          break;
        }
        if (item.kind === "error") {
          throw item.error;
        }
        yield item;
      }
      await promptPromise;

      // Bind turn completion to the session process lifecycle: an unexpected
      // exit after end_turn (immediate or delayed within the liveness window)
      // must not become turn.completed.
      await this.lifecycle.awaitAliveOrCrash(this.postTurnLivenessMs);

      yield {
        kind: "turn_completed",
        sequence: this.nextSequence(),
        at: new Date().toISOString(),
        sessionId: this.sessionId,
        ...(stopReason ? { stopReason } : {}),
      };
    } catch (error) {
      throw toDevinAcpTransportError(error, "prompt_send_failure");
    } finally {
      unsubscribeExit();
      unsubscribeMcp?.();
      this.handlers.onSessionUpdate = () => undefined;
      this.handlers.onPermission = () => ({ outcome: { outcome: "cancelled" } });
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
    } catch (error) {
      throw toDevinAcpTransportError(error, "cancelled");
    }
  }

  async closeInput(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.processHandle.closeStdin();
  }

  async waitForProcessExit(timeoutMs?: number): Promise<ProcessExit> {
    if (timeoutMs === undefined) {
      return this.processHandle.waitForExit();
    }
    return withTimeout(this.processHandle.waitForExit(), timeoutMs, "waitForProcessExit");
  }

  async terminate(graceMs = 1_000): Promise<ProcessExit> {
    this.lifecycle.markIntentionalShutdown();
    return this.processHandle.terminateTree({ graceMs });
  }
}

export class DevinAcpTransportImpl implements DevinAcpTransport {
  async start(input: StartDevinAcpInput): Promise<DevinAcpConnection> {
    try {
      assertDevinRunnable(input.diagnosis);
    } catch (error) {
      throw new DevinAcpTransportError(
        "not_runnable",
        error instanceof Error ? error.message : "Devin diagnosis is not runnable",
      );
    }

    const runner = input.runner ?? new ProcessRunner();
    const acpArgs = input.acpArgs ?? ["acp"];
    const args = [...(input.executableArgs ?? []), ...acpArgs];
    let processHandle: ManagedProcess;
    try {
      processHandle = runner.run(input.executable, args, {
        cwd: input.cwd,
        env: input.env ?? process.env,
      });
    } catch (error) {
      throw toDevinAcpTransportError(error, "spawn_failure");
    }

    const lifecycle = new AcpProcessLifecycle(processHandle);
    const postTurnLivenessMs = input.postTurnLivenessMs ?? DEFAULT_POST_TURN_LIVENESS_MS;
    const promptTimeoutMs = input.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    const mcpMonitor = createMcpPolicyMonitor(input.mcpPolicy ?? {
      policy: input.diagnosis.inheritedMcpPolicy,
      mode: "non-interactive",
      explicitAllow: false,
    });
    const stderr = await collectStderr(processHandle, (chunk) => mcpMonitor?.observe(chunk));
    const handlers: LiveHandlers = {
      onSessionUpdate: () => undefined,
      onPermission: () => ({ outcome: { outcome: "cancelled" } }),
    };

    const client: acp.Client = {
      requestPermission: async (params) => handlers.onPermission(params),
      sessionUpdate: async (notification) => {
        handlers.onSessionUpdate(notification);
      },
    };

    const connection = new acp.ClientSideConnection(
      () => client,
      acp.ndJsonStream(
        managedStdinToWritableStream(processHandle),
        asyncIterableToReadableStream(processHandle.stdout),
      ),
    );

    const guard = async <T>(promise: Promise<T>): Promise<T> => {
      const result = await promise;
      lifecycle.throwIfDead();
      return result;
    };

    try {
      const initializeResponse = await withTimeout(
        guard(
          connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
            },
            clientInfo: input.clientInfo ?? {
              name: "meguribi",
              version: "0.0.0",
            },
          }),
        ),
        input.startupTimeoutMs,
        "ACP initialize",
      );

      if (
        typeof initializeResponse.protocolVersion !== "number" ||
        initializeResponse.protocolVersion < 1
      ) {
        throw new DevinAcpTransportError(
          "capability_mismatch",
          `Unsupported ACP protocol version: ${String(initializeResponse.protocolVersion)}`,
        );
      }

      const sessionResponse = await withTimeout(
        guard(
          connection.newSession({
            cwd: input.cwd,
            mcpServers: [],
          }),
        ),
        input.startupTimeoutMs,
        "ACP session/new",
      );

      return new DevinAcpConnectionImpl(
        sessionResponse.sessionId,
        initializeResponse.protocolVersion,
        connection,
        processHandle,
        stderr,
        handlers,
        lifecycle,
        postTurnLivenessMs,
        promptTimeoutMs,
        input.cwd,
        input.permissionMediator,
        input.protectedPaths ?? [],
        mcpMonitor,
      );
    } catch (error) {
      lifecycle.markIntentionalShutdown();
      await processHandle.terminateTree({ graceMs: 500 }).catch(() => undefined);
      throw toDevinAcpTransportError(error, "initialize_failure");
    }
  }
}

export function createDevinAcpTransport(): DevinAcpTransport {
  return new DevinAcpTransportImpl();
}
