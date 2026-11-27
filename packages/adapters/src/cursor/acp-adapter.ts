import type { AgentAdapter, AgentError } from "@meguribi/core";
import {
  createGenericAcpImplementer,
  type AcpImplementerHooks,
  type AcpImplementerOptions,
} from "../acp/implementer-adapter.js";
import { CursorArtifactWriteError } from "./artifact-store.js";
import { assertCursorRunnable, CursorNotRunnableError } from "./diagnose.js";
import { CursorPromptBuildError } from "./prompt.js";
import { startCursorAcpSession } from "./session.js";

export interface CursorAcpAdapterOptions extends AcpImplementerOptions {}

export class CursorAcpAdapterError extends Error {
  constructor(
    public readonly code: AgentError["code"],
    message: string,
    public readonly isRetryable = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CursorAcpAdapterError";
  }

  toAgentError(): AgentError {
    return {
      code: this.code,
      message: this.message,
      isRetryable: this.isRetryable,
    };
  }
}

const cursorHooks: AcpImplementerHooks = {
  label: "Cursor",
  assertRunnable: assertCursorRunnable,
  isNotRunnableError: (error) => error instanceof CursorNotRunnableError,
  isPromptBuildError: (error) => error instanceof CursorPromptBuildError,
  isArtifactWriteError: (error) => error instanceof CursorArtifactWriteError,
  startSession: (input) => startCursorAcpSession(input),
};

export function createCursorAcpAdapter(options: CursorAcpAdapterOptions): AgentAdapter {
  return createGenericAcpImplementer({ ...options, hooks: cursorHooks });
}
