import type { AgentRole } from "./role-agent.js";
import type { WorkflowEvent } from "./workflow-engine/events.js";

export type AgentActivityState =
  | "starting"
  | "thinking"
  | "running_tool"
  | "waiting_permission"
  | "idle"
  | "finished"
  | "failed";

export interface AgentActivity {
  profileId: string;
  agentLabel: string;
  role: AgentRole;
  stepId: string;
  state: AgentActivityState;
  detail?: string;
  since: string;
  lastEventAt: string;
  toolCalls: number;
  changedFiles: readonly string[];
  stalled: boolean;
  stalledForMs: number;
}

export interface DeriveAgentActivityOptions {
  now: Date;
  stallWarningMs?: number;
}

const DEFAULT_STALL_WARNING_MS = 120000;
const MESSAGE_DETAIL_MAX_LENGTH = 80;

interface MutableAgentActivity {
  profileId: string;
  agentLabel: string;
  role: AgentRole;
  stepId: string;
  state: AgentActivityState;
  detail?: string;
  since: string;
  lastEventAt: string;
  toolCalls: number;
  changedFiles: string[];
  speechSessionId?: string;
  speechText: string;
}

function enterState(
  activity: MutableAgentActivity,
  state: AgentActivityState,
  at: string,
  detail?: string,
): void {
  if (activity.state !== state) {
    activity.state = state;
    activity.since = at;
  }
  activity.detail = detail;
}

function resetForStep(activity: MutableAgentActivity, stepId: string): void {
  if (activity.stepId === stepId) {
    return;
  }
  activity.stepId = stepId;
  activity.toolCalls = 0;
  activity.changedFiles = [];
  activity.speechSessionId = undefined;
  activity.speechText = "";
}

function appendMessageDelta(activity: MutableAgentActivity, sessionId: string, text: string): string {
  if (activity.speechSessionId === sessionId) {
    activity.speechText += text;
  } else {
    activity.speechSessionId = sessionId;
    activity.speechText = text;
  }
  return activity.speechText.slice(0, MESSAGE_DETAIL_MAX_LENGTH);
}

function clearSpeech(activity: MutableAgentActivity): void {
  activity.speechSessionId = undefined;
  activity.speechText = "";
}

function isInactiveState(state: AgentActivityState): boolean {
  return state === "finished" || state === "failed" || state === "idle";
}

/**
 * `agent.event` の履歴から、表示用のエージェント活動状態を導出する純粋関数。
 * workflow 全体の終了イベントだけは、未終了プロファイルを finished へ移すために参照する。
 */
export function deriveAgentActivity(
  events: readonly WorkflowEvent[],
  options: DeriveAgentActivityOptions,
): AgentActivity[] {
  const activities = new Map<string, MutableAgentActivity>();

  for (const workflowEvent of events) {
    if (workflowEvent.type === "step.started") {
      if (workflowEvent.profileId !== undefined) {
        const activity = activities.get(workflowEvent.profileId);
        if (activity !== undefined) {
          resetForStep(activity, workflowEvent.stepId);
        }
      }
      continue;
    }

    if (workflowEvent.type === "workflow.finished") {
      for (const activity of activities.values()) {
        if (activity.state !== "failed") {
          activity.state = "finished";
          activity.since = workflowEvent.at;
          activity.lastEventAt = workflowEvent.at;
          activity.detail = undefined;
        }
      }
      continue;
    }

    if (workflowEvent.type !== "agent.event") {
      continue;
    }

    const eventAt = workflowEvent.event.at;
    let activity = activities.get(workflowEvent.profileId);
    if (activity === undefined) {
      activity = {
        profileId: workflowEvent.profileId,
        agentLabel: workflowEvent.agentLabel,
        role: workflowEvent.role,
        stepId: workflowEvent.stepId,
        state: "starting",
        since: eventAt,
        lastEventAt: eventAt,
        toolCalls: 0,
        changedFiles: [],
        speechText: "",
      };
      activities.set(workflowEvent.profileId, activity);
    }

    resetForStep(activity, workflowEvent.stepId);
    activity.agentLabel = workflowEvent.agentLabel;
    activity.role = workflowEvent.role;
    activity.lastEventAt = eventAt;

    const agentEvent = workflowEvent.event;
    if (agentEvent.type !== "message.delta") {
      clearSpeech(activity);
    }

    switch (agentEvent.type) {
      case "session.started":
        enterState(activity, "starting", agentEvent.at);
        break;
      case "message.delta": {
        const detail = appendMessageDelta(activity, agentEvent.sessionId, agentEvent.text);
        enterState(activity, "thinking", agentEvent.at, detail);
        break;
      }
      case "tool.started":
        activity.toolCalls += 1;
        enterState(activity, "running_tool", agentEvent.at, agentEvent.summary ?? agentEvent.tool);
        break;
      case "tool.completed":
        enterState(activity, "thinking", agentEvent.at);
        break;
      case "file.changed":
        if (!activity.changedFiles.includes(agentEvent.path)) {
          activity.changedFiles.push(agentEvent.path);
        }
        break;
      case "approval.required":
        enterState(activity, "waiting_permission", agentEvent.at, agentEvent.summary);
        break;
      case "turn.completed":
        enterState(activity, "idle", agentEvent.at);
        break;
      case "session.failed":
        enterState(activity, "failed", agentEvent.at);
        break;
      case "unknown":
        break;
    }
  }

  const stallWarningMs = options.stallWarningMs ?? DEFAULT_STALL_WARNING_MS;
  return [...activities.values()].map((activity) => {
    const lastEventMs = Date.parse(activity.lastEventAt);
    const elapsedMs = options.now.getTime() - lastEventMs;
    const stalled =
      !isInactiveState(activity.state) &&
      Number.isFinite(elapsedMs) &&
      elapsedMs >= stallWarningMs;
    const { detail, speechSessionId: _speechSessionId, speechText: _speechText, ...rest } = activity;
    return {
      ...rest,
      ...(detail !== undefined ? { detail } : {}),
      changedFiles: [...activity.changedFiles],
      stalled,
      stalledForMs: stalled ? elapsedMs : 0,
    };
  });
}
