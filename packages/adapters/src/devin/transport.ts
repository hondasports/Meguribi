import * as acp from "@agentclientprotocol/sdk";
import type { DevinDiagnosis } from "@meguribi/core";
import {
  ProcessError,
  ProcessRunner,
  type ManagedProcess,
  type ProcessExit,
} from "@meguribi/process";
import { assertDevinRunnable } from "./diagnose.js";
import { DevinAcpTransportError } from "./transport-error.js";

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
  diagnosis: DevinDiagnosis;
  runner?: ProcessRunner;
  clientInfo?: { name: string; version: string };
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
): Promise<{ getText: () => string; done: Promise<void> }> {
  const chunks: string[] = [];
  const done = (async () => {
    for await (const chunk of processHandle.stderr) {
      chunks.push(Buffer.from(chunk).toString("utf8"));
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

/**
 * Observe whether the ACP process exited shortly after a prompt response.
 * A healthy ACP server stays alive; an early exit means the turn must not be
 * treated as a successful completion.
 */
async function observeUnexpectedExit(
  processHandle: ManagedProcess,
  graceMs: number,
): Promise<ProcessExit | undefined> {
  return Promise.race([
    processHandle.waitForExit().then((exit) => exit),
    waitMs(graceMs).then(() => undefined),
  ]);
}

function toTransportError(
  error: unknown,
  fallback: DevinAcpTransportError["code"],
): DevinAcpTransportError {
  if (error instanceof DevinAcpTransportError) {
    return error;
  }
  if (error instanceof ProcessError) {
    if (error.code === "executable_not_found") {
      return new DevinAcpTransportError("spawn_failure", error.message);
    }
    if (error.code === "timeout") {
      return new DevinAcpTransportError("startup_timeout", error.message, true);
    }
    if (error.code === "cancelled") {
      return new DevinAcpTransportError("cancelled", error.message);
    }
    if (error.code === "process_crashed") {
      return new DevinAcpTransportError("process_crashed", error.message);
    }
  }
  const message = error instanceof Error ? error.message : "Unknown ACP transport error";
  if (/capability mismatch/i.test(message)) {
    return new DevinAcpTransportError("capability_mismatch", message);
  }
  if (/session creation failed/i.test(message)) {
    return new DevinAcpTransportError("session_creation_failure", message);
  }
  if (/timeout/i.test(message)) {
    return new DevinAcpTransportError("startup_timeout", message, true);
  }
  if (/JSON|NDJSON|parse|malformed/i.test(message)) {
    return new DevinAcpTransportError("malformed_message", message);
  }
  if (/initialize/i.test(message)) {
    return new DevinAcpTransportError("initialize_failure", message);
  }
  return new DevinAcpTransportError(fallback, message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new DevinAcpTransportError(
              "startup_timeout",
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
  ) {}

  stderrText(): string {
    return this.stderr.getText();
  }

  async awaitStderrDrain(timeoutMs = 1_000): Promise<void> {
    await Promise.race([this.stderr.done, waitMs(timeoutMs)]);
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  async *prompt(input: { content: string }): AsyncIterable<RawDevinAcpEvent> {
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

    this.handlers.onSessionUpdate = (notification) => {
      const at = new Date().toISOString();
      const update = notification.update as unknown as Record<string, unknown>;
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
    this.handlers.onPermission = (params) => {
      const at = new Date().toISOString();
      const requestId = params.toolCall.toolCallId;
      const summary = params.toolCall.title ?? params.toolCall.name ?? "unknown tool";
      push({
        kind: "permission_request",
        sequence: this.nextSequence(),
        at,
        sessionId: params.sessionId,
        requestId,
        summary,
        raw: params as unknown as Record<string, unknown>,
      });
      // Permission mediation is Issue #16. Fail-closed auto-deny keeps the protocol moving.
      return { outcome: { outcome: "cancelled" } };
    };

    const promptPromise = this.connection
      .prompt({
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: input.content }],
      })
      .then((response) => {
        stopReason = response.stopReason;
        settled = true;
        wake?.();
      })
      .catch((error: unknown) => {
        settled = true;
        push({ kind: "error", error: toTransportError(error, "prompt_send_failure") });
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

      // ACP servers normally remain alive after a turn. An immediate exit after
      // a successful prompt response (e.g. crash-mid-prompt) must not become
      // turn.completed / end_turn success.
      const unexpectedExit = await observeUnexpectedExit(this.processHandle, 150);
      if (unexpectedExit) {
        throw new DevinAcpTransportError(
          "process_crashed",
          `ACP process exited after prompt response (code=${unexpectedExit.code}, signal=${unexpectedExit.signal})`,
        );
      }

      yield {
        kind: "turn_completed",
        sequence: this.nextSequence(),
        at: new Date().toISOString(),
        sessionId: this.sessionId,
        ...(stopReason ? { stopReason } : {}),
      };
    } catch (error) {
      throw toTransportError(error, "prompt_send_failure");
    } finally {
      this.handlers.onSessionUpdate = () => undefined;
      this.handlers.onPermission = () => ({ outcome: { outcome: "cancelled" } });
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
    } catch (error) {
      throw toTransportError(error, "cancelled");
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
      throw toTransportError(error, "spawn_failure");
    }

    const stderr = await collectStderr(processHandle);
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

    let processExitedEarly: DevinAcpTransportError | undefined;
    void processHandle.waitForExit().then(
      (exit) => {
        processExitedEarly = new DevinAcpTransportError(
          "process_crashed",
          `ACP process exited before protocol was ready (code=${exit.code}, signal=${exit.signal})`,
        );
      },
      (error: unknown) => {
        processExitedEarly = toTransportError(error, "spawn_failure");
      },
    );

    const guard = async <T>(promise: Promise<T>): Promise<T> => {
      const result = await promise;
      if (processExitedEarly) {
        throw processExitedEarly;
      }
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
      );
    } catch (error) {
      await processHandle.terminateTree({ graceMs: 500 }).catch(() => undefined);
      throw toTransportError(error, "initialize_failure");
    }
  }
}

export function createDevinAcpTransport(): DevinAcpTransport {
  return new DevinAcpTransportImpl();
}
