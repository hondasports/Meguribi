import type { TerminalRow, TerminalSnapshot } from "./terminal-contract.js";
import type { RunViewState } from "./run-view.js";

const TERMINAL_ROW_KINDS = new Set(["message", "tool", "status"]);

function isTerminalRow(value: unknown): value is TerminalRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<TerminalRow>;
  return (
    typeof row.id === "string" &&
    typeof row.at === "string" &&
    typeof row.profileId === "string" &&
    typeof row.label === "string" &&
    typeof row.text === "string" &&
    typeof row.active === "boolean" &&
    typeof row.kind === "string" &&
    TERMINAL_ROW_KINDS.has(row.kind)
  );
}

export function parseTerminalSnapshot(data: string | undefined): TerminalSnapshot | null {
  if (typeof data !== "string") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const rows = (payload as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || !rows.every(isTerminalRow)) return null;
  return { rows };
}

export function applyTerminalSnapshot(snapshot: TerminalSnapshot): TerminalRow[] {
  const rows: TerminalRow[] = [];
  const seen = new Set<string>();
  for (const row of snapshot.rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

export const MAX_RUN_STREAM_RECONNECT_ATTEMPTS = 5;

export const RUN_STREAM_STABLE_MS = 10_000;

export function reconnectAttemptAfterStableConnection(input: {
  attempt: number;
  connectedAt: number | null;
  eventAt: number;
}): number {
  if (input.connectedAt === null) return input.attempt;
  return input.eventAt - input.connectedAt >= RUN_STREAM_STABLE_MS ? 0 : input.attempt;
}

export function shouldReconnectRunStream(input: {
  ended: boolean;
  current: boolean;
  attempt: number;
}): boolean {
  return !input.ended && input.current && input.attempt < MAX_RUN_STREAM_RECONNECT_ATTEMPTS;
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(5000, 1000 * 2 ** Math.max(0, attempt));
}

export function streamErrorMessage(data: string | undefined): string | null {
  if (typeof data !== "string") return null;
  try {
    const payload = JSON.parse(data) as { message?: unknown };
    return typeof payload.message === "string" ? payload.message : null;
  } catch {
    return null;
  }
}

export function clearPaneTextForReplay(state: RunViewState): RunViewState {
  return {
    ...state,
    panes: state.panes.map((pane) => ({ ...pane, text: "" })),
  };
}
