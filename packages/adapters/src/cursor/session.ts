import type { ImplementationContext } from "@meguribi/core";
import { assertCursorRunnable } from "./diagnose.js";
import { CursorAgentArtifactStore } from "./artifact-store.js";
import { buildCursorPrompt } from "./prompt.js";
import {
  startAcpSession,
  type AcpGitBoundaryConfig,
  type AcpSession,
  type StartAcpSessionInput,
} from "../acp/session.js";

export type CursorGitBoundaryConfig = AcpGitBoundaryConfig;
export type CursorAcpSession = AcpSession;
export interface StartCursorAcpSessionInput
  extends Omit<StartAcpSessionInput, "assertRunnable" | "createArtifactStore" | "promptArtifact"> {
  implementationContext?: ImplementationContext;
}

export async function startCursorAcpSession(
  input: StartCursorAcpSessionInput,
): Promise<CursorAcpSession> {
  const { implementationContext, ...rest } = input;
  const promptArtifact = implementationContext
    ? buildCursorPrompt(implementationContext)
    : undefined;

  return startAcpSession({
    ...rest,
    assertRunnable: assertCursorRunnable,
    createArtifactStore: (root) => new CursorAgentArtifactStore(root),
    promptArtifact,
  });
}
