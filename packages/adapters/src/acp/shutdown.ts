import type { AgentError, AgentTerminationReason, AgentTerminationResult } from "@meguribi/core";
import type { ProcessExit } from "@meguribi/process";

export interface AcpConnection {
  cancel(): Promise<void> | void;
  closeInput(): Promise<void> | void;
  waitForProcessExit(timeoutMs: number): Promise<ProcessExit>;
  terminate(timeoutMs: number): Promise<ProcessExit>;
}

export interface ShutdownOptions {
  gracefulShutdownMs: number;
  terminateTimeoutMs: number;
  stopReason?: string;
}

function safeError(error: unknown): AgentError {
  return {
    code: "cleanup_failed",
    message: error instanceof Error ? error.message : "ACP cleanup failed",
    isRetryable: false,
  };
}

export class AcpShutdownController {
  private resultPromise: Promise<AgentTerminationResult> | undefined;

  constructor(private readonly connection: Pick<AcpConnection, "cancel" | "closeInput" | "waitForProcessExit" | "terminate">) {}

  shutdown(reason: AgentTerminationReason, options: ShutdownOptions): Promise<AgentTerminationResult> {
    if (!this.resultPromise) {
      this.resultPromise = this.perform(reason, options);
    }
    return this.resultPromise;
  }

  private async perform(reason: AgentTerminationReason, options: ShutdownOptions): Promise<AgentTerminationResult> {
    let cancelSent = false;
    let stdinClosed = false;
    let gracefulExit = false;
    let terminateSent = false;
    let forceKillUsed = false;
    let cleanupError: AgentError | undefined;
    let exit: ProcessExit | undefined;

    if (reason !== "completed") {
      try {
        await this.connection.cancel();
        cancelSent = true;
      } catch (error) {
        cleanupError ??= safeError(error);
      }
    }
    try {
      await this.connection.closeInput();
      stdinClosed = true;
    } catch (error) {
      cleanupError ??= safeError(error);
    }
    try {
      exit = await this.connection.waitForProcessExit(options.gracefulShutdownMs);
      gracefulExit = true;
    } catch {
      // The process did not exit during the graceful window; escalate below.
    }
    if (!gracefulExit) {
      terminateSent = true;
      try {
        exit = await this.connection.terminate(options.terminateTimeoutMs);
        forceKillUsed = exit.forceKillUsed ?? false;
      } catch (error) {
        cleanupError ??= safeError(error);
      }
    }

    return {
      reason,
      ...(options.stopReason ? { stopReason: options.stopReason } : {}),
      stdinClosed,
      cancelSent,
      gracefulExit,
      terminateSent,
      forceKillUsed,
      residualProcesses: exit ? 0 : 1,
      ...(cleanupError ? { cleanupError } : {}),
    };
  }
}
