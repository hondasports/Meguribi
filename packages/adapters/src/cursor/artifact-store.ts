import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentEvent, AgentTerminationResult } from "@meguribi/core";
import { redactDiagnosticText, redactJsonValue } from "../acp/redact.js";

export class CursorArtifactWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CursorArtifactWriteError";
  }
}

export interface CursorAgentSessionMetadata {
  sessionId: string;
  cwd: string;
  protocolVersion?: number;
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface CursorAgentResultArtifact {
  status: "completed" | "failed" | "cancelled" | "blocked";
  sessionId: string;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  reportedFiles?: readonly string[];
}

export interface CursorPromptArtifact {
  version: string;
  hash: string;
  content: string;
}

export interface CursorGitBoundaryArtifact {
  verdict: "allowed" | "blocked" | "suspicious";
  publishable: boolean;
  reasons: readonly string[];
  warnings: readonly string[];
  changedFiles: readonly string[];
  preExistingDirty: boolean;
}

export interface PersistedAgentEvent {
  sequence: number;
  at: string;
  event: AgentEvent;
}

export interface PersistedRawEvent {
  sequence: number;
  at: string;
  kind: string;
  raw: unknown;
}

/**
 * Narrow filesystem port for Cursor agent artifacts until RunStore exists.
 * Always redacts before persistence. Redaction / write failures are fail-closed.
 */
export class CursorAgentArtifactStore {
  readonly rawEventsPath: string;
  readonly eventsPath: string;
  readonly stderrPath: string;
  readonly sessionPath: string;
  readonly resultPath: string;
  readonly promptPath: string;
  readonly promptMetadataPath: string;
  readonly gitBoundaryPath: string;
  readonly terminationPath: string;

  private sequence = 0;
  private initialized = false;
  private readonly appendQueues = new Map<string, Promise<void>>();

  constructor(readonly root: string) {
    this.rawEventsPath = path.join(root, "raw-events.jsonl");
    this.eventsPath = path.join(root, "events.jsonl");
    this.stderrPath = path.join(root, "stderr.log");
    this.sessionPath = path.join(root, "session.json");
    this.resultPath = path.join(root, "result.json");
    this.promptPath = path.join(root, "cursor-prompt.md");
    this.promptMetadataPath = path.join(root, "prompt.json");
    this.gitBoundaryPath = path.join(root, "git-boundary.json");
    this.terminationPath = path.join(root, "termination.json");
  }

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /**
   * Create missing artifact files without truncating existing evidence.
   * Restores the sequence counter from the highest sequence already on disk.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      await fs.mkdir(this.root, { recursive: true });
      await Promise.all([
        ensureFileExists(this.rawEventsPath),
        ensureFileExists(this.eventsPath),
        ensureFileExists(this.stderrPath),
      ]);
      this.sequence = await restoreMaxSequence([this.rawEventsPath, this.eventsPath]);
      this.initialized = true;
    } catch (error) {
      throw new CursorArtifactWriteError("Failed to initialize Cursor agent artifact directory", {
        cause: error,
      });
    }
  }

  async appendRaw(
    kind: string,
    raw: unknown,
    sequence = this.nextSequence(),
    at = new Date().toISOString(),
  ): Promise<PersistedRawEvent> {
    await this.ensureReady();
    let redacted: unknown;
    try {
      redacted = redactJsonValue(raw);
    } catch (error) {
      throw new CursorArtifactWriteError("Failed to redact raw ACP event before persistence", {
        cause: error,
      });
    }
    const record: PersistedRawEvent = { sequence, at, kind, raw: redacted };
    await this.appendJsonl(this.rawEventsPath, record);
    return record;
  }

  async appendEvent(event: AgentEvent, sequence: number, at = event.at): Promise<PersistedAgentEvent> {
    await this.ensureReady();
    let safeEvent: AgentEvent;
    try {
      safeEvent = redactAgentEvent(event);
    } catch (error) {
      throw new CursorArtifactWriteError("Failed to redact AgentEvent before persistence", {
        cause: error,
      });
    }
    const record: PersistedAgentEvent = { sequence, at, event: safeEvent };
    await this.appendJsonl(this.eventsPath, record);
    return record;
  }

  async appendStderr(chunk: string): Promise<void> {
    await this.ensureReady();
    try {
      const redacted = redactDiagnosticText(chunk);
      await atomicAppendFile(this.stderrPath, redacted);
    } catch (error) {
      throw new CursorArtifactWriteError("Failed to append stderr.log", { cause: error });
    }
  }

  async writeSession(metadata: CursorAgentSessionMetadata): Promise<void> {
    await this.ensureReady();
    await this.writeJson(this.sessionPath, metadata);
  }

  async writeResult(result: CursorAgentResultArtifact): Promise<void> {
    await this.ensureReady();
    await this.writeJson(this.resultPath, result);
  }

  async writePrompt(prompt: CursorPromptArtifact): Promise<void> {
    await this.ensureReady();
    const redactedContent = redactDiagnosticText(prompt.content);
    const actualHash = `sha256:${createHash("sha256").update(redactedContent, "utf8").digest("hex")}`;
    if (actualHash !== prompt.hash) {
      throw new CursorArtifactWriteError("Prompt hash does not match the redacted prompt content");
    }
    await this.writeJson(this.promptMetadataPath, {
      version: prompt.version,
      hash: prompt.hash,
    });
    await atomicWriteFile(this.promptPath, redactedContent);
  }

  async writeGitBoundary(result: CursorGitBoundaryArtifact): Promise<void> {
    await this.ensureReady();
    await this.writeJson(this.gitBoundaryPath, result);
  }

  async writeTermination(result: AgentTerminationResult): Promise<void> {
    await this.ensureReady();
    await this.writeJson(this.terminationPath, result);
  }

  private async ensureReady(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  private async appendJsonl(filePath: string, value: unknown): Promise<void> {
    const previous = this.appendQueues.get(filePath) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        const line = `${JSON.stringify(value)}\n`;
        JSON.parse(line);
        await atomicAppendFile(filePath, line);
      } catch (error) {
        throw new CursorArtifactWriteError(`Failed to append JSONL: ${path.basename(filePath)}`, {
          cause: error,
        });
      }
    });
    this.appendQueues.set(filePath, next);
    try {
      await next;
    } finally {
      if (this.appendQueues.get(filePath) === next) this.appendQueues.delete(filePath);
    }
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    try {
      const redacted = redactJsonValue(value);
      await atomicWriteFile(filePath, `${JSON.stringify(redacted, null, 2)}\n`);
    } catch (error) {
      throw new CursorArtifactWriteError(`Failed to write ${path.basename(filePath)}`, {
        cause: error,
      });
    }
  }
}

async function ensureFileExists(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await atomicWriteFile(filePath, "");
  }
}

async function restoreMaxSequence(filePaths: string[]): Promise<number> {
  let max = 0;
  for (const filePath of filePaths) {
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { sequence?: unknown };
        if (typeof parsed.sequence === "number" && Number.isFinite(parsed.sequence)) {
          max = Math.max(max, Math.floor(parsed.sequence));
        }
      } catch {
        // Skip malformed historical lines; do not wipe the file.
      }
    }
  }
  return max;
}

async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Append a complete JSONL record while the per-file queue is held. Using the
 * native append operation avoids Windows rename failures when another process
 * is reading the artifact file during a live run.
 */
async function atomicAppendFile(filePath: string, chunk: string): Promise<void> {
  await fs.appendFile(filePath, chunk, "utf8");
}

function redactAgentEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "message.delta":
      return { ...event, text: redactDiagnosticText(event.text) };
    case "tool.started":
      return {
        ...event,
        ...(event.summary ? { summary: redactDiagnosticText(event.summary) } : {}),
      };
    case "approval.required":
      return { ...event, summary: redactDiagnosticText(event.summary) };
    case "session.failed":
      return {
        ...event,
        error: {
          ...event.error,
          message: redactDiagnosticText(event.error.message),
        },
      };
    default:
      return event;
  }
}
