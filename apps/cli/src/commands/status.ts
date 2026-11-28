import { homedir } from "node:os";
import path from "node:path";
import {
  createLiveLogRenderer,
  deriveAgentActivity,
  type AgentActivity,
  type LiveLogEvent,
  type RunState,
  type RunStore,
  type WorkflowEvent,
  type WorkflowEventLog,
  type WorkflowEventRecord,
} from "@meguribi/core";
import {
  FileSystemRunStore,
  FileSystemWorkflowEventLog,
  redactDiagnosticText,
} from "@meguribi/adapters";

export interface StatusCommandOptions {
  follow?: boolean;
  agent?: string;
  json?: boolean;
  runsRoot?: string;
}

export interface StatusCommandDependencies {
  runStore?: RunStore;
  eventLog?: WorkflowEventLog;
  now?: () => Date;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  abortSignal?: AbortSignal;
}

const TERMINAL_STATUSES = new Set<RunState["status"]>([
  "awaiting_human",
  "blocked",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

function localDataRoot(): string {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "meguribi");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "meguribi");
  }
  return path.join(homedir(), ".local", "share", "meguribi");
}

function emptyEventLog(): WorkflowEventLog {
  return {
    append: async () => {
      throw new Error("Workflow event log is not configured");
    },
    read: async () => ({ records: [], nextLine: 0, skippedLines: 0 }),
  };
}

function resolveStores(
  options: StatusCommandOptions,
  deps: StatusCommandDependencies,
): { runStore: RunStore; eventLog: WorkflowEventLog } {
  const runStore = deps.runStore ?? new FileSystemRunStore({ rootDir: options.runsRoot ?? localDataRoot() });
  const eventLog = deps.eventLog ??
    (runStore instanceof FileSystemRunStore
      ? new FileSystemWorkflowEventLog({ runStore })
      : emptyEventLog());
  return { runStore, eventLog };
}

function writeRunNotFound(stderr: (text: string) => void, runId: string): void {
  stderr(`Run not found: ${runId}\n`);
  stderr('Next: meguribi status に渡す runId は meguribi run / resume の出力の "Run:" 行で確認できます\n');
}

function isLiveLogEvent(event: WorkflowEvent): event is LiveLogEvent {
  return event.type === "step.started" || event.type === "agent.event";
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return `${String(totalSeconds)}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${String(totalMinutes)}m${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}h${String(minutes).padStart(2, "0")}m`;
}

function formatActivity(activity: AgentActivity, now: Date): string {
  const normalizedDetail = activity.detail?.replace(/\s+/g, " ").trim();
  const detail = normalizedDetail ? ` ${normalizedDetail}` : "";
  const elapsed = formatElapsed(now.getTime() - Date.parse(activity.since));
  const stalled = activity.stalled
    ? `  応答なし ${String(Math.floor(activity.stalledForMs / 60000))}分`
    : "";
  return `  ${activity.agentLabel} (${activity.role}) ${activity.state}${detail} ${elapsed}${stalled}\n`;
}

function filterActivities(
  activities: readonly AgentActivity[],
  agent: string | undefined,
): AgentActivity[] {
  return agent === undefined
    ? [...activities]
    : activities.filter((activity) => activity.profileId === agent);
}

function formatHumanStatus(
  state: RunState,
  activities: readonly AgentActivity[],
  now: Date,
  agent: string | undefined,
): string {
  const lines = [
    `Run: ${state.runId}  (${state.repository}#${String(state.issueNumber)})`,
    `Status: ${state.status}  Step: ${state.currentStep ?? "-"}  Fix: ${String(state.fixAttempts)}/${String(state.maxFixAttempts)}`,
  ];
  if (activities.length === 0) {
    if (agent !== undefined) {
      lines.push("Agents:", `  この Run に ${agent} のイベントはありません`);
    } else {
      lines.push("Agents: (no agent events yet)");
    }
  } else {
    lines.push("Agents:");
    for (const activity of activities) {
      lines.push(formatActivity(activity, now).replace(/\n$/, ""));
    }
  }
  return `${lines.join("\n")}\n`;
}

function deriveVisibleActivities(
  records: readonly WorkflowEventRecord[],
  now: Date,
  agent: string | undefined,
): AgentActivity[] {
  const activities = deriveAgentActivity(records.map((record) => record.event), { now });
  return filterActivities(activities, agent);
}

function writeSnapshot(
  state: RunState,
  records: readonly WorkflowEventRecord[],
  options: StatusCommandOptions,
  now: Date,
  stdout: (text: string) => void,
): void {
  const activities = deriveVisibleActivities(records, now, options.agent);
  if (options.json) {
    stdout(`${JSON.stringify({ state, activities })}\n`);
    return;
  }
  stdout(formatHumanStatus(state, activities, now, options.agent));
}

function isTerminal(state: RunState): boolean {
  return TERMINAL_STATUSES.has(state.status);
}

export async function runStatusCommand(
  runId: string,
  options: StatusCommandOptions,
  deps: StatusCommandDependencies = {},
): Promise<{ exitCode: number }> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { runStore, eventLog } = resolveStores(options, deps);

  let state = await runStore.load(runId);
  if (state === null) {
    writeRunNotFound(stderr, runId);
    return { exitCode: 1 };
  }

  if (!options.follow) {
    const result = await eventLog.read(runId, 0);
    if (result.skippedLines > 0) {
      stderr(`warning: skipped ${String(result.skippedLines)} malformed event line(s)\n`);
    }
    writeSnapshot(state, result.records, options, now(), stdout);
    return { exitCode: 0 };
  }

  const renderer = createLiveLogRenderer({
    mode: "stream",
    color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
    redact: redactDiagnosticText,
    ...(options.agent !== undefined ? { onlyProfileId: options.agent } : {}),
  });
  const collectedRecords: WorkflowEventRecord[] = [];
  let nextLine = 0;
  let malformedWarningWritten = false;
  let selectedAgentSeen = false;

  const drain = async (): Promise<void> => {
    const result = await eventLog.read(runId, nextLine);
    nextLine = result.nextLine;
    if (result.skippedLines > 0 && !malformedWarningWritten) {
      stderr(`warning: skipped ${String(result.skippedLines)} malformed event line(s)\n`);
      malformedWarningWritten = true;
    }
    for (const record of result.records) {
      collectedRecords.push(record);
      const event = record.event;
      if (
        options.agent !== undefined &&
        ((event.type === "agent.event" && event.profileId === options.agent) ||
          (event.type === "step.started" && event.profileId === options.agent))
      ) {
        selectedAgentSeen = true;
      }
      if (!options.json && isLiveLogEvent(event)) {
        const rendered = renderer.render(event);
        if (rendered.length > 0) {
          stdout(rendered);
        }
      }
    }
  };

  await drain();
  if (options.agent !== undefined && !selectedAgentSeen) {
    stderr(`この Run に ${options.agent} のイベントはまだありません。待機中…\n`);
  }

  const isAborted = (): boolean => deps.abortSignal?.aborted === true;
  while (!isTerminal(state) && !isAborted()) {
    await sleep(1000);
    if (isAborted()) {
      break;
    }
    await drain();
    state = await runStore.load(runId) ?? state;
  }

  if (options.json) {
    writeSnapshot(state, collectedRecords, options, now(), stdout);
  } else {
    const flushed = renderer.flush();
    if (flushed.length > 0) {
      stdout(flushed);
    }
  }
  return { exitCode: 0 };
}
