import type { WorkflowEvent } from "./events.js";

export interface WorkflowEventRecord {
  at: string;
  event: WorkflowEvent;
}

export interface WorkflowEventLog {
  append(runId: string, event: WorkflowEvent, at?: string): Promise<void>;
  read(
    runId: string,
    fromLine?: number,
  ): Promise<{
    records: WorkflowEventRecord[];
    nextLine: number;
    skippedLines: number;
  }>;
}
