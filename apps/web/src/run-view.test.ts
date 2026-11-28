import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivity, AgentActivityState, RunState } from "@meguribi/core";
import type { RunDetail } from "../server/run-store-api.js";
import {
  applyDetail,
  applyLog,
  createRunViewState,
  formatElapsed,
  stateLabelJa,
} from "./run-view.js";

function runState(): RunState {
  return {
    schemaVersion: 1,
    runId: "2026-11-28T120000Z-test01",
    repository: "owner/repo",
    issueNumber: 42,
    command: "run",
    status: "implementing",
    currentStep: "implementing",
    completedSteps: [],
    branch: "meguribi/issue-42",
    worktreePath: "/tmp/worktree",
    baseRef: "origin/main",
    baseSha: "base",
    headSha: "head",
    remoteIdentity: "github.com/owner/repo",
    pullRequestNumber: null,
    agentSessions: {},
    fixAttempts: 0,
    maxFixAttempts: 1,
    createdAt: "2026-11-28T12:00:00.000Z",
    updatedAt: "2026-11-28T12:00:00.000Z",
  };
}

function activity(input: {
  profileId: string;
  agentLabel?: string;
  role?: AgentActivity["role"];
  state: AgentActivityState;
  since: string;
  detail?: string;
  stalled?: boolean;
  stalledForMs?: number;
}): AgentActivity {
  return {
    profileId: input.profileId,
    agentLabel: input.agentLabel ?? input.profileId,
    role: input.role ?? "implementer",
    stepId: "implement",
    state: input.state,
    since: input.since,
    lastEventAt: input.since,
    toolCalls: 0,
    changedFiles: [],
    stalled: input.stalled ?? false,
    stalledForMs: input.stalledForMs ?? 0,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
}

function detail(activities: AgentActivity[]): RunDetail {
  return {
    state: runState(),
    pipeline: [],
    activities,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("run view state", () => {
  it("starts with the overall pane and agent-tab selection", () => {
    const state = createRunViewState();
    expect(state.selectedPane).toBe("agents");
    expect(state.panes).toEqual([
      { id: "all", title: "全体", text: "", active: false, stalled: false, stateLabel: "" },
    ]);
  });

  it("appends log chunks without clearing existing pane text", () => {
    const initial = createRunViewState();
    const withAll = applyLog(initial, { pane: "all", text: "first\n" });
    const withProfile = applyLog(withAll, { pane: "devin", text: "hello" });
    const appended = applyLog(withProfile, { pane: "devin", text: " world" });

    expect(appended.panes.find((pane) => pane.id === "all")?.text).toBe("first\n");
    expect(appended.panes.find((pane) => pane.id === "devin")?.text).toBe("hello world");
    expect(initial.panes[0]?.text).toBe("");
  });

  it("truncates each pane to 200000 characters from the head", () => {
    const first = "x".repeat(199_999);
    let state = applyLog(createRunViewState(), { pane: "all", text: first });
    state = applyLog(state, { pane: "all", text: "yz" });
    const text = state.panes.find((pane) => pane.id === "all")?.text ?? "";

    expect(text).toHaveLength(200_000);
    expect(text.startsWith("x")).toBe(true);
    expect(text.endsWith("yz")).toBe(true);
  });

  it("adds activity panes in first-seen order and preserves their logs when another agent appears", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-28T12:04:00.000Z"));
    let state = applyDetail(createRunViewState(), detail([
      activity({
        profileId: "devin",
        agentLabel: "Devin",
        state: "running_tool",
        detail: "pnpm test",
        since: "2026-11-28T12:00:48.000Z",
      }),
    ]));
    state = applyLog(state, { pane: "devin", text: "devin log\n" });
    state = applyDetail(state, detail([
      activity({
        profileId: "devin",
        agentLabel: "Devin",
        state: "running_tool",
        detail: "pnpm test",
        since: "2026-11-28T12:00:48.000Z",
      }),
      activity({
        profileId: "codex",
        agentLabel: "Codex",
        role: "reviewer",
        state: "finished",
        since: "2026-11-28T12:03:00.000Z",
      }),
    ]));

    expect(state.panes.map((pane) => pane.id)).toEqual(["all", "devin", "codex"]);
    expect(state.panes.find((pane) => pane.id === "devin")?.text).toBe("devin log\n");
    expect(state.panes.find((pane) => pane.id === "devin")).toMatchObject({
      title: "Devin · implementer",
      active: true,
      stalled: false,
      stateLabel: "実行中 3m12s",
    });
    expect(state.panes.find((pane) => pane.id === "codex")).toMatchObject({
      title: "Codex · reviewer",
      active: false,
      stateLabel: "完了 1m00s",
    });
  });

  it("marks permission and thinking states active and appends stalled warning", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-28T12:10:00.000Z"));
    const state = applyDetail(createRunViewState(), detail([
      activity({
        profileId: "devin",
        agentLabel: "Devin",
        state: "waiting_permission",
        since: "2026-11-28T12:08:48.000Z",
        stalled: true,
        stalledForMs: 180_000,
      }),
      activity({
        profileId: "codex",
        agentLabel: "Codex",
        role: "planner",
        state: "thinking",
        since: "2026-11-28T12:09:58.000Z",
      }),
    ]));

    expect(state.panes.find((pane) => pane.id === "devin")).toMatchObject({
      active: true,
      stalled: true,
      stateLabel: "権限待ち 1m12s  応答なし 3分",
    });
    expect(state.panes.find((pane) => pane.id === "codex")).toMatchObject({
      active: true,
      stalled: false,
      stateLabel: "考え中 2s",
    });
  });

  it("formats elapsed time like the status command", () => {
    expect(formatElapsed(12_000)).toBe("12s");
    expect(formatElapsed(192_000)).toBe("3m12s");
    expect(formatElapsed(185_000)).toBe("3m05s");
    expect(formatElapsed(3_900_000)).toBe("1h05m");
    expect(formatElapsed(-100)).toBe("0s");
  });

  it("maps agent states to Japanese labels", () => {
    const expected: Record<AgentActivityState, string> = {
      starting: "起動中",
      thinking: "考え中",
      running_tool: "実行中",
      waiting_permission: "権限待ち",
      idle: "待機",
      finished: "完了",
      failed: "失敗",
    };
    for (const [state, label] of Object.entries(expected)) {
      expect(stateLabelJa(state as AgentActivityState)).toBe(label);
    }
  });
});
