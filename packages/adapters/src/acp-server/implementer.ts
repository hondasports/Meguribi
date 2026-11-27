import type { AgentAdapter, AgentProfile } from "@meguribi/core";
import { agentDisplayName } from "@meguribi/core";
import {
  createGenericAcpImplementer,
  type AcpImplementerHooks,
  type AcpImplementerOptions,
} from "../acp/implementer-adapter.js";
import {
  AcpAgentArtifactStore,
  AcpArtifactWriteError,
} from "../acp/artifact-store.js";
import {
  AcpPromptBuildError,
  buildAcpImplementationPrompt,
} from "../acp/implementation-prompt.js";
import { startAcpSession } from "../acp/session.js";
import {
  AcpServerNotRunnableError,
  assertAcpServerRunnable,
} from "./diagnose.js";

export const ACP_SERVER_PROMPT_VERSION = "meguribi-acp-prompt/v1";

export type AcpServerImplementerOptions = Omit<AcpImplementerOptions, "executable"> & {
  profile: AgentProfile;
  executable: string;
  executableArgs?: string[];
};

function createAcpServerHooks(profile: AgentProfile): AcpImplementerHooks {
  const label = agentDisplayName(profile.kind);
  return {
    label,
    assertRunnable: assertAcpServerRunnable,
    isNotRunnableError: (error) => error instanceof AcpServerNotRunnableError,
    isPromptBuildError: (error) => error instanceof AcpPromptBuildError,
    isArtifactWriteError: (error) => error instanceof AcpArtifactWriteError,
    startSession: (input) => {
      const { implementationContext, ...rest } = input;
      const promptArtifact = buildAcpImplementationPrompt(implementationContext, {
        version: ACP_SERVER_PROMPT_VERSION,
        label,
      });
      return startAcpSession({
        ...rest,
        acpArgs: [],
        assertRunnable: assertAcpServerRunnable,
        createArtifactStore: (root) =>
          new AcpAgentArtifactStore(root, {
            label,
            promptFileName: `${profile.id}-prompt.md`,
          }),
        promptArtifact,
      });
    },
  };
}

export function createAcpServerImplementer(options: AcpServerImplementerOptions): AgentAdapter {
  const { profile } = options;
  return createGenericAcpImplementer({
    ...options,
    inheritedMcpPolicy: profile.inheritedMcpPolicy,
    startupTimeoutMs: profile.startupTimeoutMs,
    promptTimeoutMs: options.promptTimeoutMs ?? profile.turnTimeoutMinutes * 60_000,
    acpArgs: [],
    hooks: createAcpServerHooks(profile),
  });
}
