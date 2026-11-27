import type { AgentEvent } from "./agent-event.js";
import type { AgentRole } from "./role-agent.js";

/**
 * CLI のライブログへ流すイベント。
 * `step.started` は工程の切り替わり、`agent.event` はエージェントの活動。
 */
export type LiveLogEvent =
  | {
      type: "step.started";
      stepId: string;
      label: string;
      role?: AgentRole;
      profileId?: string;
      agentLabel?: string;
    }
  | {
      type: "agent.event";
      stepId: string;
      profileId: string;
      agentLabel: string;
      role: AgentRole;
      event: AgentEvent;
    };

export type LiveLogMode = "stream" | "compact";

export interface LiveLogOptions {
  mode: LiveLogMode;
  color: boolean;
  redact?: (text: string) => string;
  width?: number /* 既定 64 */;
  onlyProfileId?: string /* エージェント別画面用 */;
}

export interface LiveLogRenderer {
  render(event: LiveLogEvent): string;
  flush(): string;
}

const SUMMARY_MAX_LENGTH = 120;
const LABEL_COLOR_CYCLE = [36, 35, 33, 32, 34] as const;
const FAILURE_COLOR = 31;
const APPROVAL_COLOR = 33;

function paint(text: string, code: number): string {
  return `\u001b[${String(code)}m${text}\u001b[0m`;
}

/**
 * エージェント CLI 風のライブログを整形する純粋なレンダラー。
 * 状態は closure 内に持ち、呼び出しごとに書き出すべき文字列だけを返す。
 */
export function createLiveLogRenderer(options: LiveLogOptions): LiveLogRenderer {
  const width = options.width ?? 64;
  const redact = options.redact ?? ((text: string) => text);

  let atLineStart = true;
  let speechSessionId: string | undefined;
  const toolStartedAt = new Map<string, number>();
  const labelColors = new Map<string, number>();

  function emit(text: string): string {
    if (text.length > 0) {
      atLineStart = text.endsWith("\n");
    }
    return text;
  }

  function labelColor(profileId: string): number {
    let color = labelColors.get(profileId);
    if (color === undefined) {
      color = LABEL_COLOR_CYCLE[labelColors.size % LABEL_COLOR_CYCLE.length]!;
      labelColors.set(profileId, color);
    }
    return color;
  }

  function colorizeLabel(agentLabel: string, profileId: string | undefined): string {
    if (!options.color || profileId === undefined) {
      return agentLabel;
    }
    return paint(agentLabel, labelColor(profileId));
  }

  function paintLine(line: string, code: number): string {
    if (!options.color) {
      return line;
    }
    const body = line.endsWith("\n") ? line.slice(0, -1) : line;
    return `${paint(body, code)}\n`;
  }

  function truncateSummary(summary: string): string {
    const redacted = redact(summary);
    if (redacted.length > SUMMARY_MAX_LENGTH) {
      return `${redacted.slice(0, SUMMARY_MAX_LENGTH)}…`;
    }
    return redacted;
  }

  function interruptSpeech(): string {
    speechSessionId = undefined;
    return atLineStart ? "" : "\n";
  }

  function renderStepStarted(event: Extract<LiveLogEvent, { type: "step.started" }>): string {
    const rolePart = event.agentLabel !== undefined && event.role !== undefined ? ` (${event.role})` : "";
    const plainLabel = event.agentLabel ?? event.label;
    const visibleHead = `── ${event.stepId} · ${plainLabel}${rolePart} `;
    const fill = "─".repeat(Math.max(0, width - visibleHead.length));
    const shownLabel =
      event.agentLabel !== undefined ? colorizeLabel(event.agentLabel, event.profileId) : event.label;
    const head = `── ${event.stepId} · ${shownLabel}${rolePart} `;
    return emit(`${interruptSpeech()}${head}${fill}\n`);
  }

  function renderMessageDelta(
    agentLabel: string,
    profileId: string,
    event: Extract<AgentEvent, { type: "message.delta" }>,
  ): string {
    const text = redact(event.text);
    if (speechSessionId === event.sessionId) {
      return emit(text);
    }
    const prefix = interruptSpeech();
    speechSessionId = event.sessionId;
    return emit(`${prefix}● ${colorizeLabel(agentLabel, profileId)}  ${text}`);
  }

  function renderToolStarted(
    event: Extract<AgentEvent, { type: "tool.started" }>,
  ): string {
    if (event.toolCallId !== undefined) {
      const startedAt = Date.parse(event.at);
      if (!Number.isNaN(startedAt)) {
        toolStartedAt.set(event.toolCallId, startedAt);
      }
    }
    const summary = event.summary !== undefined ? `  ${truncateSummary(event.summary)}` : "";
    const prefix = interruptSpeech();
    if (options.mode === "compact") {
      return emit(`${prefix}  · ${event.tool}${summary}\n`);
    }
    return emit(`${prefix}● ${event.tool}${summary}\n`);
  }

  function renderToolCompleted(
    event: Extract<AgentEvent, { type: "tool.completed" }>,
  ): string {
    const parts = [`  └ ${event.status ?? "completed"}`];
    if (event.exitCode !== undefined) {
      parts.push(` · exit ${String(event.exitCode)}`);
    }
    if (event.toolCallId !== undefined) {
      const startedAt = toolStartedAt.get(event.toolCallId);
      const finishedAt = Date.parse(event.at);
      if (startedAt !== undefined && !Number.isNaN(finishedAt)) {
        toolStartedAt.delete(event.toolCallId);
        parts.push(` · ${((finishedAt - startedAt) / 1000).toFixed(1)}s`);
      }
    }
    return emit(`${interruptSpeech()}${parts.join("")}\n`);
  }

  function renderApprovalRequired(
    event: Extract<AgentEvent, { type: "approval.required" }>,
  ): string {
    const summary = redact(event.summary);
    let line: string;
    if (event.decision === undefined) {
      line = `⚠ 権限  ${summary} → 確認待ち\n`;
    } else {
      const outcome =
        event.decision.outcome === "approve"
          ? "許可"
          : event.decision.outcome === "deny"
            ? "拒否"
            : "確認待ち";
      line = `⚠ 権限  ${summary} → ${outcome}（${redact(event.decision.reason)}）\n`;
    }
    return emit(`${interruptSpeech()}${paintLine(line, APPROVAL_COLOR)}`);
  }

  function renderSessionFailed(
    agentLabel: string,
    event: Extract<AgentEvent, { type: "session.failed" }>,
  ): string {
    const line = `✗ ${agentLabel}  ${event.error.code}: ${redact(event.error.message)}\n`;
    return emit(`${interruptSpeech()}${paintLine(line, FAILURE_COLOR)}`);
  }

  function renderAgentEvent(
    stepEvent: Extract<LiveLogEvent, { type: "agent.event" }>,
  ): string {
    const event = stepEvent.event;
    switch (event.type) {
      case "message.delta":
        if (options.mode === "compact") {
          return "";
        }
        return renderMessageDelta(stepEvent.agentLabel, stepEvent.profileId, event);
      case "tool.started":
        return renderToolStarted(event);
      case "tool.completed":
        if (options.mode === "compact") {
          return "";
        }
        return renderToolCompleted(event);
      case "file.changed":
        if (options.mode === "compact") {
          return "";
        }
        return emit(`${interruptSpeech()}  └ changed · ${redact(event.path)}\n`);
      case "approval.required":
        return renderApprovalRequired(event);
      case "session.failed":
        return renderSessionFailed(stepEvent.agentLabel, event);
      case "turn.completed":
        speechSessionId = undefined;
        return "";
      case "session.started":
      case "unknown":
        return "";
    }
  }

  return {
    render(event: LiveLogEvent): string {
      if (options.onlyProfileId !== undefined && event.profileId !== options.onlyProfileId) {
        return "";
      }
      if (event.type === "step.started") {
        return renderStepStarted(event);
      }
      return renderAgentEvent(event);
    },
    flush(): string {
      speechSessionId = undefined;
      if (atLineStart) {
        return "";
      }
      atLineStart = true;
      return "\n";
    },
  };
}
