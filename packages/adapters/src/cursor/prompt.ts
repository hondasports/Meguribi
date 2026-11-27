import type { ImplementationContext } from "@meguribi/core";
import {
  AcpPromptBuildError,
  buildAcpImplementationPrompt,
} from "../acp/implementation-prompt.js";

export const CURSOR_PROMPT_VERSION = "meguribi-cursor-prompt/v1";

export interface BuiltCursorPrompt {
  version: string;
  hash: string;
  content: string;
}

export class CursorPromptBuildError extends AcpPromptBuildError {
  constructor(message: string) {
    super(message);
    this.name = "CursorPromptBuildError";
  }
}

export function buildCursorPrompt(context: ImplementationContext): BuiltCursorPrompt {
  try {
    return buildAcpImplementationPrompt(context, {
      version: CURSOR_PROMPT_VERSION,
      label: "Cursor",
    });
  } catch (error) {
    if (error instanceof AcpPromptBuildError) {
      throw new CursorPromptBuildError(error.message);
    }
    throw error;
  }
}
