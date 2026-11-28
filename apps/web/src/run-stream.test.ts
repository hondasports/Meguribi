import { describe, expect, it } from "vitest";
import type { TerminalRow, TerminalSnapshot } from "./terminal-contract.js";
import {
  applyTerminalSnapshot,
  clearPaneTextForReplay,
  parseTerminalSnapshot,
  MAX_RUN_STREAM_RECONNECT_ATTEMPTS,
  reconnectAttemptAfterStableConnection,
  reconnectDelayMs,
  RUN_STREAM_STABLE_MS,
  shouldReconnectRunStream,
  streamErrorMessage,
} from "./run-stream.js";
import { createRunViewState, applyLog } from "./run-view.js";

function row(id: string): TerminalRow {
  return {
    id,
    at: "2026-11-28T10:00:00Z",
    profileId: "devin",
    label: "Devin CLI",
    kind: "message",
    text: `row ${id}`,
    active: false,
  };
}

describe("terminal snapshot", () => {
  it("replaces existing rows with the bounded snapshot instead of appending replayed rows", () => {
    const replayed = [row("1"), row("2"), row("3")];
    expect(
      applyTerminalSnapshot({ rows: replayed } satisfies TerminalSnapshot).map((item) => item.id),
    ).toEqual(["1", "2", "3"]);
    expect(
      applyTerminalSnapshot({ rows: [row("2")] } satisfies TerminalSnapshot).map((item) => item.id),
    ).toEqual(["2"]);
  });

  it("parses a valid terminal SSE payload and rejects malformed payloads without throwing", () => {
    expect(parseTerminalSnapshot(JSON.stringify({ rows: [row("1")] }))).toEqual({
      rows: [row("1")],
    });
    expect(parseTerminalSnapshot(undefined)).toBeNull();
    expect(parseTerminalSnapshot("not json")).toBeNull();
    expect(parseTerminalSnapshot(JSON.stringify({ rows: [{ id: "broken" }] }))).toBeNull();
  });
});

describe("run stream reconnect", () => {
  it("does not reconnect terminal, stale, or exhausted streams", () => {
    const active = { ended: false, current: true, attempt: 0 };
    expect(shouldReconnectRunStream({ ...active, ended: true })).toBe(false);
    expect(shouldReconnectRunStream({ ...active, current: false })).toBe(false);
    expect(shouldReconnectRunStream(active)).toBe(true);
    expect(
      shouldReconnectRunStream({ ...active, attempt: MAX_RUN_STREAM_RECONNECT_ATTEMPTS }),
    ).toBe(false);
    expect(MAX_RUN_STREAM_RECONNECT_ATTEMPTS).toBe(5);
  });

  it("backs off reconnect attempts without a tight loop", () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(2)).toBe(4000);
    expect(reconnectDelayMs(3)).toBe(5000);
    expect(reconnectDelayMs(10)).toBe(5000);
  });

  it("ignores native error events without MessageEvent data", () => {
    expect(streamErrorMessage(undefined)).toBeNull();
    expect(streamErrorMessage(JSON.stringify({ message: "read failed" }))).toBe("read failed");
  });

  it("clears pane text once before replay while preserving pane metadata and detail", () => {
    const withLogs = applyLog(applyLog(createRunViewState(), { pane: "all", text: "old" }), {
      pane: "devin",
      text: "agent old",
    });
    const detail = {
      state: { runId: "run-1" },
      pipeline: [],
      activities: [],
    } as never;
    const state = { ...withLogs, detail };
    const reset = clearPaneTextForReplay(state);
    expect(reset.panes.map((pane) => pane.text)).toEqual(["", ""]);
    expect(reset.panes.map((pane) => pane.id)).toEqual(["all", "devin"]);
    expect(reset.detail).toBe(detail);
  });
  it("does not reset attempts for immediate replay bursts and keeps the five retry cap", () => {
    let attempt = 0;
    const delays: number[] = [];
    for (let failure = 0; failure < 5; failure += 1) {
      delays.push(reconnectDelayMs(attempt));
      attempt += 1;
      for (const replayAt of [100, 500, 1500]) {
        attempt = reconnectAttemptAfterStableConnection({
          attempt,
          connectedAt: 0,
          eventAt: replayAt,
        });
      }
    }
    expect(delays).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(attempt).toBe(5);
    expect(shouldReconnectRunStream({ ended: false, current: true, attempt })).toBe(false);
    expect(
      reconnectAttemptAfterStableConnection({
        attempt,
        connectedAt: 0,
        eventAt: RUN_STREAM_STABLE_MS,
      }),
    ).toBe(0);
    expect(
      reconnectAttemptAfterStableConnection({
        attempt,
        connectedAt: null,
        eventAt: RUN_STREAM_STABLE_MS * 2,
      }),
    ).toBe(attempt);
  });
});
