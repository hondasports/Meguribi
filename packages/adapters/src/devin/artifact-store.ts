import fs from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "@meguribi/core";
import { redactDiagnosticText } from "./redact.js";

export class DevinArtifactWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DevinArtifactWriteError";
  }
}

export interface DevinAgentSessionMetadata {
  sessionId: string;
  cwd: string;
  protocolVersion?: number;
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface DevinAgentResultArtifact {
  status: "completed" | "failed" | "cancelled" | "blocked";
  sessionId: string;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
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
 * Narrow filesystem port for Devin agent artifacts until RunStore exists.
 * Always redacts before persistence. Redaction / write failures are fail-closed.
 */
export class DevinAgentArtifactStore {
  readonly rawEventsPath: string;
  readonly eventsPath: string;
  readonly stderrPath: string;
  readonly sessionPath: string;
  readonly resultPath: string;

  private sequence = 0;
  private initialized = false;

  constructor(readonly root: string) {
    this.rawEventsPath = path.join(root, "raw-events.jsonl");
    this.eventsPath = path.join(root, "events.jsonl");
    this.stderrPath = path.join(root, "stderr.log");
    this.sessionPath = path.join(root, "session.json");
    this.resultPath = path.join(root, "result.json");
  }

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      await fs.mkdir(this.root, { recursive: true });
      await Promise.all([
        fs.writeFile(this.rawEventsPath, "", "utf8"),
        fs.writeFile(this.eventsPath, "", "utf8"),
        fs.writeFile(this.stderrPath, "", "utf8"),
      ]);
      this.initialized = true;
    } catch (error) {
      throw new DevinArtifactWriteError("Failed to initialize Devin agent artifact directory", {
        cause: error,
      });
    }
  }

  async appendRaw(kind: string, raw: unknown, sequence = this.nextSequence(), at = new Date().toISOString()): Promise<PersistedRawEvent> {
    await this.ensureReady();
    let redacted: unknown;
    try {
      redacted = redactJsonValue(raw);
    } catch (error) {
      throw new DevinArtifactWriteError("Failed to redact raw ACP event before persistence", {
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
      throw new DevinArtifactWriteError("Failed to redact AgentEvent before persistence", {
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
      await fs.appendFile(this.stderrPath, redacted, "utf8");
    } catch (error) {
      throw new DevinArtifactWriteError("Failed to append stderr.log", { cause: error });
    }
  }

  async writeSession(metadata: DevinAgentSessionMetadata): Promise<void> {
    await this.ensureReady();
    await this.writeJson(this.sessionPath, metadata);
  }

  async writeResult(result: DevinAgentResultArtifact): Promise<void> {
    await this.ensureReady();
    await this.writeJson(this.resultPath, result);
  }

  private async ensureReady(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  private async appendJsonl(filePath: string, value: unknown): Promise<void> {
    try {
      const line = `${JSON.stringify(value)}\n`;
      // Validate the line itself is parseable JSON before writing.
      JSON.parse(line);
      await fs.appendFile(filePath, line, "utf8");
    } catch (error) {
      throw new DevinArtifactWriteError(`Failed to append JSONL: ${path.basename(filePath)}`, {
        cause: error,
      });
    }
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    try {
      const redacted = redactJsonValue(value);
      await fs.writeFile(filePath, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
    } catch (error) {
      throw new DevinArtifactWriteError(`Failed to write ${path.basename(filePath)}`, {
        cause: error,
      });
    }
  }
}

function redactJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactDiagnosticText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      redactJsonValue(child),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
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
