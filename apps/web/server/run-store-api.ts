import type http from "node:http";
import {
  createDeliveryWorkflow,
  createLiveLogRenderer,
  deriveAgentActivity,
  type AgentActivity,
  type ApprovalRecord,
  type DiscussionConclusion,
  type DiscussionTurn,
  type LiveLogRenderer,
  type RunState,
  type StepKind,
  type WorkflowEvent,
  type WorkflowEventLog,
} from "@meguribi/core";
import {
  FileSystemDiscussionStore,
  redactDiagnosticText,
  redactJsonValue,
  type FileSystemRunStore,
} from "@meguribi/adapters";

export interface RunSummary {
  runId: string;
  repository: string;
  issueNumber: number | null;
  command: string;
  status: string;
  currentStep?: string;
  updatedAt: string;
  pullRequestNumber: number | null;
}

export type PipelineStepStatus = "pending" | "running" | "completed" | "failed";

export interface PipelineStep {
  stepId: string;
  kind: StepKind;
  status: PipelineStepStatus;
  visit: number;
}

export interface RunDetail {
  state: RunState;
  pipeline: PipelineStep[];
  activities: AgentActivity[];
}

export interface DiscussionDetail {
  turns: DiscussionTurn[];
  conclusion: DiscussionConclusion | null;
  approval: ApprovalRecord | null;
  canInterject: boolean;
  canDecide: boolean;
}

export interface RunStoreApiOptions {
  runStore: FileSystemRunStore;
  eventLog: WorkflowEventLog;
  now?: () => Date;
  pollMs?: number;
}

const RUNS_PATH = "/api/run-store/runs";
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_POLL_MS = 1000;
const TERMINAL_STATUSES = new Set<string>([
  "awaiting_human",
  "blocked",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "completed",
]);

type RunStoreRoute =
  | { kind: "list"; searchParams: URLSearchParams }
  | { kind: "detail"; runId: string }
  | { kind: "discussion"; runId: string }
  | { kind: "stream"; runId: string };

function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(value)}\n`);
}

function writeSse(res: http.ServerResponse, name: string, value: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
}

function parseRoute(rawUrl: string | undefined): RunStoreRoute | null {
  if (rawUrl === undefined) return null;
  const queryIndex = rawUrl.indexOf("?");
  const rawPath = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
  const searchParams = new URLSearchParams(queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : "");
  if (rawPath === RUNS_PATH) return { kind: "list", searchParams };
  const prefix = `${RUNS_PATH}/`;
  if (!rawPath.startsWith(prefix)) return null;
  const remainder = rawPath.slice(prefix.length);
  const segments = remainder.split("/");
  const suffix = segments.length === 2 ? segments[1] : undefined;
  if (segments.length !== 1 && suffix !== "stream" && suffix !== "discussion") {
    return null;
  }
  let runId: string;
  try {
    runId = decodeURIComponent(segments[0] ?? "");
  } catch {
    return {
      kind: suffix === "stream" ? "stream" : suffix === "discussion" ? "discussion" : "detail",
      runId: "",
    };
  }
  return {
    kind: suffix === "stream" ? "stream" : suffix === "discussion" ? "discussion" : "detail",
    runId,
  };
}

export function isValidRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId) && !runId.includes("..");
}

function parseListLimit(searchParams: URLSearchParams): number | null {
  const raw = searchParams.get("limit");
  if (raw === null) return DEFAULT_LIST_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, MAX_LIST_LIMIT);
}

function summarizeRun(state: RunState): RunSummary {
  return {
    runId: state.runId,
    repository: state.repository,
    issueNumber: state.issueNumber,
    command: state.command,
    status: state.status,
    ...(state.currentStep !== undefined ? { currentStep: state.currentStep } : {}),
    updatedAt: state.updatedAt,
    pullRequestNumber: state.pullRequestNumber,
  };
}

function ensurePipelineStep(
  steps: PipelineStep[],
  indexes: Map<string, number>,
  stepId: string,
  kind: StepKind,
): PipelineStep {
  const existingIndex = indexes.get(stepId);
  if (existingIndex !== undefined) return steps[existingIndex]!;
  const step: PipelineStep = { stepId, kind, status: "pending", visit: 0 };
  indexes.set(stepId, steps.length);
  steps.push(step);
  return step;
}

function buildPipeline(state: RunState, events: readonly WorkflowEvent[]): PipelineStep[] {
  const steps: PipelineStep[] =
    state.command === "run" || state.command === "resume"
      ? createDeliveryWorkflow(state.maxFixAttempts).steps.map((step) => ({
          stepId: step.id,
          kind: step.kind,
          status: "pending" as const,
          visit: 0,
        }))
      : [];
  const indexes = new Map(steps.map((step, index) => [step.stepId, index]));

  for (const event of events) {
    if (
      event.type !== "workflow.step.started" &&
      event.type !== "workflow.step.completed" &&
      event.type !== "workflow.step.failed"
    ) {
      continue;
    }
    const step = ensurePipelineStep(steps, indexes, event.stepId, event.kind);
    if (event.type === "workflow.step.started") {
      step.status = "running";
      step.visit = Math.max(step.visit, event.visit);
    } else {
      step.status = event.type === "workflow.step.completed" ? "completed" : "failed";
      if (step.visit === 0) step.visit = 1;
    }
  }
  return steps;
}

function redactRunState(state: RunState): RunState {
  const common = {
    worktreePath: redactDiagnosticText(state.worktreePath),
    remoteIdentity: redactDiagnosticText(state.remoteIdentity),
    ...(state.lastError !== undefined
      ? {
          lastError: {
            ...state.lastError,
            message: redactDiagnosticText(state.lastError.message),
          },
        }
      : {}),
  };
  if (state.command === "consult") {
    return {
      ...state,
      ...common,
      branch: null,
      baseRef: null,
    };
  }
  return {
    ...state,
    ...common,
    branch: redactDiagnosticText(state.branch),
    baseRef: redactDiagnosticText(state.baseRef),
  };
}

function redactActivity(activity: AgentActivity): AgentActivity {
  return {
    ...activity,
    agentLabel: redactDiagnosticText(activity.agentLabel),
    ...(activity.detail !== undefined ? { detail: redactDiagnosticText(activity.detail) } : {}),
    changedFiles: activity.changedFiles.map((file) => redactDiagnosticText(file)),
  };
}

const INTERJECT_CLOSED_STATUSES = new Set<string>([
  "awaiting_human",
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

function isApprovalRecord(value: unknown): value is ApprovalRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ApprovalRecord>;
  return (
    (record.decision === "approved" || record.decision === "rejected") &&
    typeof record.approver === "string" &&
    typeof record.at === "string" &&
    typeof record.conclusionHash === "string" &&
    (record.comment === undefined || typeof record.comment === "string") &&
    (record.redo === undefined || typeof record.redo === "boolean")
  );
}

function redacted<T>(value: T): T {
  return redactJsonValue(value) as T;
}

export async function readDiscussionDetail(
  runStore: FileSystemRunStore,
  runId: string,
): Promise<DiscussionDetail | null> {
  const state = await runStore.load(runId);
  if (state === null || (state.command !== "discuss" && state.command !== "consult")) return null;
  const store = new FileSystemDiscussionStore({ runStore, runId });
  const [turns, conclusion, approvalValue] = await Promise.all([
    store.readTurns(),
    store.readConclusion(),
    runStore.readArtifact<unknown>(runId, "approval.json"),
  ]);
  const approval = isApprovalRecord(approvalValue) ? approvalValue : null;
  return {
    turns: redacted(turns),
    conclusion: conclusion === null ? null : redacted(conclusion),
    approval: approval === null ? null : redacted(approval),
    canInterject: !INTERJECT_CLOSED_STATUSES.has(state.status),
    canDecide: state.command === "discuss" && state.status === "awaiting_human" && conclusion !== null,
  };
}

function buildRunDetail(
  state: RunState,
  events: readonly WorkflowEvent[],
  now: Date,
): RunDetail {
  return {
    state: redactRunState(state),
    pipeline: buildPipeline(state, events),
    activities: deriveAgentActivity(events, { now }).map(redactActivity),
  };
}

export function createRunStoreApi(options: RunStoreApiOptions): {
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
} {
  const now = options.now ?? (() => new Date());
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  async function loadDetail(runId: string): Promise<RunDetail | null> {
    const state = await options.runStore.load(runId);
    if (state === null) return null;
    const result = await options.eventLog.read(runId, 0);
    return buildRunDetail(state, result.records.map((record) => record.event), now());
  }

  async function handleList(searchParams: URLSearchParams, res: http.ServerResponse): Promise<void> {
    const limit = parseListLimit(searchParams);
    if (limit === null) {
      writeJson(res, 400, { error: "limit must be a positive integer" });
      return;
    }
    const states = await options.runStore.listRecent(limit);
    writeJson(res, 200, states.map(summarizeRun));
  }

  async function handleDetail(runId: string, res: http.ServerResponse): Promise<void> {
    const detail = await loadDetail(runId);
    if (detail === null) {
      writeJson(res, 404, { error: "Run not found" });
      return;
    }
    writeJson(res, 200, detail);
  }

  async function handleDiscussion(runId: string, res: http.ServerResponse): Promise<void> {
    const detail = await readDiscussionDetail(options.runStore, runId);
    if (detail === null) {
      writeJson(res, 404, { error: "Discussion run not found" });
      return;
    }
    writeJson(res, 200, detail);
  }

  async function handleStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    runId: string,
  ): Promise<void> {
    const initialState = await options.runStore.load(runId);
    if (initialState === null) {
      writeJson(res, 404, { error: "Run not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const rendererOptions = {
      mode: "stream" as const,
      color: false,
      redact: redactDiagnosticText,
    };
    const allRenderer = createLiveLogRenderer(rendererOptions);
    const paneRenderers = new Map<string, LiveLogRenderer>();
    const events: WorkflowEvent[] = [];
    let nextLine = 0;
    let pollCount = 0;
    let sentInitialDetail = false;
    let closed = false;
    let draining = false;
    let drainAgain = false;

    function paneRenderer(profileId: string): LiveLogRenderer {
      let renderer = paneRenderers.get(profileId);
      if (renderer === undefined) {
        renderer = createLiveLogRenderer({ ...rendererOptions, onlyProfileId: profileId });
        paneRenderers.set(profileId, renderer);
      }
      return renderer;
    }

    function writeRenderedEvent(event: WorkflowEvent): void {
      if (event.type !== "step.started" && event.type !== "agent.event") return;
      const allText = allRenderer.render(event);
      if (allText.length > 0) writeSse(res, "log", { pane: "all", text: allText });
      if (event.profileId !== undefined) {
        const paneText = paneRenderer(event.profileId).render(event);
        if (paneText.length > 0) writeSse(res, "log", { pane: event.profileId, text: paneText });
      }
    }

    async function writeDetail(): Promise<void> {
      if (closed || res.writableEnded) return;
      const state = await options.runStore.load(runId);
      if (state === null || closed || res.writableEnded) return;
      writeSse(res, "detail", buildRunDetail(state, events, now()));
    }

    async function writeDiscussionDetail(): Promise<void> {
      if (closed || res.writableEnded) return;
      const detail = await readDiscussionDetail(options.runStore, runId);
      if (detail !== null && !closed && !res.writableEnded) {
        writeSse(res, "discussion", detail);
      }
    }

    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(timer);
    }

    function flushRenderers(): void {
      const allText = allRenderer.flush();
      if (allText.length > 0) writeSse(res, "log", { pane: "all", text: allText });
      for (const [profileId, renderer] of paneRenderers) {
        const paneText = renderer.flush();
        if (paneText.length > 0) writeSse(res, "log", { pane: profileId, text: paneText });
      }
    }

    function finish(status: string): void {
      if (closed) return;
      flushRenderers();
      writeSse(res, "end", { status });
      cleanup();
      res.end();
    }

    async function drain(): Promise<void> {
      if (closed) return;
      if (draining) {
        drainAgain = true;
        return;
      }
      draining = true;
      try {
        do {
          drainAgain = false;
          const result = await options.eventLog.read(runId, nextLine);
          nextLine = result.nextLine;
          let sawDiscussionEvent = false;
          for (const record of result.records) {
            events.push(record.event);
            if (
              record.event.type === "discussion.turn" ||
              record.event.type === "discussion.ended"
            ) {
              sawDiscussionEvent = true;
            }
            writeRenderedEvent(record.event);
          }
          pollCount += 1;
          if (!sentInitialDetail || result.records.length > 0 || pollCount % 5 === 0) {
            await writeDetail();
            sentInitialDetail = true;
          }
          if (sawDiscussionEvent) {
            await writeDiscussionDetail();
          }
          const state = await options.runStore.load(runId);
          if (closed) return;
          if (state !== null && TERMINAL_STATUSES.has(state.status)) {
            finish(state.status);
            return;
          }
        } while (drainAgain && !closed);
      } catch (error) {
        if (!closed && !res.writableEnded) {
          writeSse(res, "error", {
            message: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
          });
        }
        cleanup();
        if (!res.writableEnded) res.end();
      } finally {
        draining = false;
      }
    }

    const timer = setInterval(() => {
      void drain();
    }, pollMs);
    res.on("close", cleanup);
    req.on("close", cleanup);
    void drain();
  }

  return {
    async handle(req, res) {
      const rawPath = (req.url ?? "").split("?", 1)[0] ?? "";
      if (!rawPath.startsWith("/api/run-store/") && rawPath !== RUNS_PATH) return false;
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      const route = parseRoute(req.url);
      if (route === null) {
        writeJson(res, 404, { error: "Not found" });
        return true;
      }
      if (route.kind === "list") {
        await handleList(route.searchParams, res);
        return true;
      }
      if (!isValidRunId(route.runId)) {
        writeJson(res, 400, { error: "Invalid run id" });
        return true;
      }
      if (route.kind === "detail") {
        await handleDetail(route.runId, res);
      } else if (route.kind === "discussion") {
        await handleDiscussion(route.runId, res);
      } else {
        await handleStream(req, res, route.runId);
      }
      return true;
    },
  };
}
