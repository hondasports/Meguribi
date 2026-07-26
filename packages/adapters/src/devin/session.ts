import type { ImplementationContext } from "@meguribi/core";
import { assertDevinRunnable } from "./diagnose.js";
import { DevinAgentArtifactStore } from "./artifact-store.js";
import { buildDevinPrompt } from "./prompt.js";
import {
  startAcpSession,
  type AcpGitBoundaryConfig,
  type AcpSession,
  type StartAcpSessionInput,
} from "../acp/session.js";

export type DevinGitBoundaryConfig = AcpGitBoundaryConfig;
export type DevinAcpSession = AcpSession;
export interface StartDevinAcpSessionInput
  extends Omit<StartAcpSessionInput, "assertRunnable" | "createArtifactStore" | "promptArtifact"> {
  implementationContext?: ImplementationContext;
}

export async function startDevinAcpSession(
  input: StartDevinAcpSessionInput,
): Promise<DevinAcpSession> {
  const { implementationContext, ...rest } = input;
  const promptArtifact = implementationContext
    ? buildDevinPrompt(implementationContext)
    : undefined;

  return startAcpSession({
    ...rest,
    assertRunnable: assertDevinRunnable,
    createArtifactStore: (root) => new DevinAgentArtifactStore(root),
    promptArtifact,
  });
}
