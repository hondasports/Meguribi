import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkflowEvent,
  WorkflowEventLog,
  WorkflowEventRecord,
} from "@meguribi/core";
import { redactJsonValue } from "../acp/redact.js";
import type { FileSystemRunStore } from "./filesystem-run-store.js";

export class FileSystemWorkflowEventLog implements WorkflowEventLog {
  private readonly runStore: FileSystemRunStore;
  private readonly now: () => Date;

  constructor(options: { runStore: FileSystemRunStore; now?: () => Date }) {
    this.runStore = options.runStore;
    this.now = options.now ?? (() => new Date());
  }

  async append(runId: string, event: WorkflowEvent, at?: string): Promise<void> {
    const runDirectory = await this.runStore.runDirectory(runId);
    if (runDirectory === null) {
      throw new Error(`Run not found: ${runId}`);
    }
    const record: WorkflowEventRecord = {
      at: at ?? this.now().toISOString(),
      event: redactJsonValue(event) as WorkflowEvent,
    };
    await fs.appendFile(
      path.join(runDirectory, "events.jsonl"),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
  }

  async read(
    runId: string,
    fromLine = 0,
  ): Promise<{ records: WorkflowEventRecord[]; nextLine: number; skippedLines: number }> {
    if (!Number.isInteger(fromLine) || fromLine < 0) {
      throw new Error(`fromLine must be a non-negative integer: ${String(fromLine)}`);
    }
    const runDirectory = await this.runStore.runDirectory(runId);
    if (runDirectory === null) {
      throw new Error(`Run not found: ${runId}`);
    }

    let contents: string;
    try {
      contents = await fs.readFile(path.join(runDirectory, "events.jsonl"), "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { records: [], nextLine: 0, skippedLines: 0 };
      }
      throw error;
    }

    const completeLines = contents.split("\n").slice(0, -1);
    const records: WorkflowEventRecord[] = [];
    let skippedLines = 0;
    for (const line of completeLines.slice(fromLine)) {
      const record = parseWorkflowEventRecord(line);
      if (record === null) {
        skippedLines += 1;
      } else {
        records.push(record);
      }
    }
    return { records, nextLine: completeLines.length, skippedLines };
  }
}

function parseWorkflowEventRecord(line: string): WorkflowEventRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed.at !== "string" || !isWorkflowEvent(parsed.event)) {
      return null;
    }
    return { at: parsed.at, event: parsed.event };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WORKFLOW_EVENT_TYPES = new Set([
  "step.started",
  "agent.event",
  "step.progress",
  "discussion.turn",
  "discussion.ended",
  "workflow.started",
  "workflow.step.started",
  "workflow.step.completed",
  "workflow.step.failed",
  "workflow.finished",
]);

function isWorkflowEvent(value: unknown): value is WorkflowEvent {
  return isRecord(value) && typeof value.type === "string" && WORKFLOW_EVENT_TYPES.has(value.type);
}
