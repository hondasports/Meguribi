import type { AgentActivity, AgentActivityState } from "@meguribi/core";
import type { RunDetail } from "../server/run-store-api.js";

export interface PaneState {
  id: string;
  title: string;
  text: string;
  active: boolean;
  stalled: boolean;
  stateLabel: string;
}

export interface RunViewState {
  detail?: RunDetail;
  panes: PaneState[];
  selectedPane: "agents" | "all";
}

const MAX_PANE_TEXT_LENGTH = 200_000;
const ACTIVE_STATES = new Set<AgentActivityState>([
  "thinking",
  "running_tool",
  "waiting_permission",
]);

function overallPane(): PaneState {
  return { id: "all", title: "全体", text: "", active: false, stalled: false, stateLabel: "" };
}

function emptyAgentPane(profileId: string): PaneState {
  return {
    id: profileId,
    title: profileId,
    text: "",
    active: false,
    stalled: false,
    stateLabel: "",
  };
}

function appendPaneText(text: string, chunk: string): string {
  const appended = text + chunk;
  return appended.length > MAX_PANE_TEXT_LENGTH
    ? appended.slice(appended.length - MAX_PANE_TEXT_LENGTH)
    : appended;
}

function paneForActivity(existing: PaneState | undefined, activity: AgentActivity, now: Date): PaneState {
  const base = existing ?? { ...emptyAgentPane(activity.profileId), text: "" };
  const elapsed = formatElapsed(now.getTime() - Date.parse(activity.since));
  const stalled = activity.stalled
    ? `  応答なし ${String(Math.floor(activity.stalledForMs / 60000))}分`
    : "";
  return {
    ...base,
    title: `${activity.agentLabel} · ${activity.role}`,
    active: ACTIVE_STATES.has(activity.state),
    stalled: activity.stalled,
    stateLabel: `${stateLabelJa(activity.state)} ${elapsed}${stalled}`,
  };
}

export function createRunViewState(): RunViewState {
  return { panes: [overallPane()], selectedPane: "agents" };
}

export function applyLog(state: RunViewState, chunk: { pane: string; text: string }): RunViewState {
  const panes = state.panes.map((pane) => ({ ...pane }));
  const index = panes.findIndex((pane) => pane.id === chunk.pane);
  if (index >= 0) {
    panes[index]!.text = appendPaneText(panes[index]!.text, chunk.text);
  } else {
    panes.push({ ...emptyAgentPane(chunk.pane), text: appendPaneText("", chunk.text) });
  }
  return { ...state, panes };
}

export function applyDetail(state: RunViewState, detail: RunDetail): RunViewState {
  const now = new Date();
  const panes = state.panes.map((pane) => ({ ...pane }));
  for (const activity of detail.activities) {
    const index = panes.findIndex((pane) => pane.id === activity.profileId);
    if (index >= 0) {
      panes[index] = paneForActivity(panes[index], activity, now);
    } else {
      panes.push(paneForActivity(undefined, activity, now));
    }
  }
  return { ...state, detail, panes };
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${String(totalMinutes)}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}h${String(minutes).padStart(2, "0")}m`;
}

export function stateLabelJa(state: AgentActivityState): string {
  switch (state) {
    case "starting":
      return "起動中";
    case "thinking":
      return "考え中";
    case "running_tool":
      return "実行中";
    case "waiting_permission":
      return "権限待ち";
    case "idle":
      return "待機";
    case "finished":
      return "完了";
    case "failed":
      return "失敗";
  }
}
