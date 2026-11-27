import {
  AcpAgentArtifactStore,
  AcpArtifactWriteError,
} from "../acp/artifact-store.js";
import type {
  AcpAgentResultArtifact,
  AcpAgentSessionMetadata,
  AcpGitBoundaryArtifact,
  AcpPromptArtifact,
  PersistedAgentEvent,
  PersistedRawEvent,
} from "../acp/session.js";

export class CursorArtifactWriteError extends AcpArtifactWriteError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CursorArtifactWriteError";
  }
}

export type CursorAgentSessionMetadata = AcpAgentSessionMetadata;
export type CursorAgentResultArtifact = AcpAgentResultArtifact;
export type CursorPromptArtifact = AcpPromptArtifact;
export type CursorGitBoundaryArtifact = AcpGitBoundaryArtifact;
export type { PersistedAgentEvent, PersistedRawEvent };

/**
 * Cursor-flavored artifact store: shares the generic ACP implementation with
 * Cursor-specific labels and error types.
 */
export class CursorAgentArtifactStore extends AcpAgentArtifactStore {
  constructor(root: string) {
    super(root, { label: "Cursor", promptFileName: "cursor-prompt.md" });
  }

  protected override createWriteError(
    message: string,
    options?: { cause?: unknown },
  ): CursorArtifactWriteError {
    return new CursorArtifactWriteError(message, options);
  }
}
