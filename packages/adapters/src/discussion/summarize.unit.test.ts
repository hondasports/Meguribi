import type {
  AgentPrompt,
  DiscussionConclusionContent,
  DiscussionTurn,
  RoleAgent,
  RoleSession,
  SummarizeDiscussionInput,
} from "@meguribi/core";
import { describe, expect, it, vi } from "vitest";
import { RolePlanningError } from "../role-planning/index.js";
import { hashConclusion, hashTranscript, summarizeDiscussion } from "./summarize.js";

interface ScriptedSession extends RoleSession {
  readonly prompts: string[];
  closed: boolean;
}

function fakeRoleAgent(script: readonly string[]): {
  agent: RoleAgent;
  sessions: ScriptedSession[];
  openInputs: unknown[];
} {
  const sessions: ScriptedSession[] = [];
  const openInputs: unknown[] = [];
  const agent: RoleAgent = {
    profileId: "claude",
    kind: "claude-code",
    async openSession(input): Promise<RoleSession> {
      openInputs.push(input);
      let index = 0;
      const prompts: string[] = [];
      const session: ScriptedSession = {
        sessionId: `summary-session-${sessions.length + 1}`,
        prompts,
        closed: false,
        async send(prompt: AgentPrompt) {
          prompts.push(prompt.content);
          const text = script[Math.min(index, script.length - 1)] ?? "";
          index += 1;
          return { sessionId: session.sessionId, text, events: [] };
        },
        async close() {
          session.closed = true;
        },
      };
      sessions.push(session);
      return session;
    },
  };
  return { agent, sessions, openInputs };
}

function jsonFenced(value: unknown): string {
  return ["説明文", "```json", JSON.stringify(value), "```"].join("\n");
}

function makeTurn(turnId: string, message: string): DiscussionTurn {
  return {
    turnId,
    speaker: "claude",
    speakerLabel: "Claude Code",
    envelope: {
      message,
      replyTo: [],
      addressTo: [],
      positions: [],
      newIssues: [],
      done: true,
    },
    malformed: false,
    at: "2026-11-28T10:00:00.000Z",
  };
}

function conclusionContent(turnId: string): DiscussionConclusionContent {
  return {
    topic: "通知タイミング",
    conclusion: "夜間通知は朝にまとめる",
    issues: [
      {
        issue: "通知タイミング",
        positions: [{ participant: "claude", stance: "夜間はまとめる", turnIds: [turnId] }],
        resolution: "朝にまとめる",
      },
    ],
    rejectedOptions: [
      { option: "通知数の上限", reason: "重要通知を落とす", turnIds: [turnId] },
    ],
    openQuestions: [],
    acceptanceCriteriaSeeds: ["夜間の通知が朝にまとめられる"],
  };
}

function summarizeInput(agent: RoleAgent, turns: readonly DiscussionTurn[]): SummarizeDiscussionInput {
  return {
    summarizer: agent,
    cwd: "/tmp/worktree",
    artifactRoot: "/tmp/artifacts",
    brief: {
      runId: "run-1",
      topic: "通知タイミング",
      issueBody: "issue body",
      comments: [],
      repositoryRules: "rules",
      participants: [{ id: "claude", label: "Claude Code" }],
      redoNotes: [],
    },
    turns,
    endedBy: "consensus",
  };
}

describe("hashTranscript and hashConclusion", () => {
  it("returns the same sha256 hex for the same JSON content and a different one for changed content", () => {
    const turns = [makeTurn("t-1", "first")];
    const sameTurns = [makeTurn("t-1", "first")];
    const changedTurns = [makeTurn("t-1", "first!")];

    expect(hashTranscript(turns)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashTranscript(turns)).toBe(hashTranscript(sameTurns));
    expect(hashTranscript(turns)).not.toBe(hashTranscript(changedTurns));

    const conclusion = {
      ...conclusionContent("t-1"),
      endedBy: "consensus" as const,
      transcriptHash: hashTranscript(turns),
    };
    expect(hashConclusion(conclusion)).toBe(hashConclusion({ ...conclusion }));
    expect(hashConclusion(conclusion)).not.toBe(
      hashConclusion({ ...conclusion, conclusion: "changed" }),
    );
  });
});

describe("summarizeDiscussion", () => {
  it("retries when turnIds do not exist and succeeds with transcript hash", async () => {
    const turns = [makeTurn("t-1", "夜間はまとめるべきです")];
    const invalid = conclusionContent("t-missing");
    const valid = conclusionContent("t-1");
    const { agent, sessions, openInputs } = fakeRoleAgent([jsonFenced(invalid), jsonFenced(valid)]);
    const input = summarizeInput(agent, turns);
    const promptInputs: unknown[] = [];

    const result = await summarizeDiscussion(input, (promptInput) => {
      promptInputs.push(promptInput);
      return "initial summarizer prompt";
    });

    expect(promptInputs).toEqual([
      { brief: input.brief, transcript: turns, endedBy: "consensus" },
    ]);
    expect(openInputs[0]).toMatchObject({
      cwd: "/tmp/worktree",
      mode: "read-only",
      role: "summarizer",
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.prompts).toHaveLength(2);
    expect(sessions[0]?.prompts[0]).toBe("initial summarizer prompt");
    expect(sessions[0]?.prompts[1]).toContain("summarizer");
    expect(sessions[0]?.prompts[1]).toContain("acceptanceCriteriaSeeds");
    expect(sessions[0]?.closed).toBe(true);
    expect(result).toEqual({
      ...valid,
      endedBy: "consensus",
      transcriptHash: hashTranscript(turns),
    });
  });

  it("throws RolePlanningError after three failed validation attempts", async () => {
    const turns = [makeTurn("t-1", "夜間はまとめるべきです")];
    const invalid = jsonFenced(conclusionContent("t-missing"));
    const { agent, sessions } = fakeRoleAgent([invalid, invalid, invalid]);
    const input = summarizeInput(agent, turns);

    const error = await summarizeDiscussion(input, () => "prompt").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RolePlanningError);
    expect((error as RolePlanningError).code).toBe("malformed_output");
    expect((error as RolePlanningError).attempts).toBe(3);
    expect(sessions[0]?.prompts).toHaveLength(3);
    expect(sessions[0]?.closed).toBe(true);
  });

  it("cancels an in-flight send, closes the session, and propagates cancelled", async () => {
    const turns = [makeTurn("t-1", "夜間はまとめるべきです")];
    const controller = new AbortController();
    const openInputs: { abortSignal?: AbortSignal }[] = [];
    let resolveSend: ((result: { sessionId: string; text: string; events: [] }) => void) | undefined;
    const close = vi.fn(async () => undefined);
    const session: RoleSession = {
      sessionId: "summary-cancelled",
      async send() {
        return await new Promise((resolve) => {
          resolveSend = resolve;
        });
      },
      close,
    };
    const agent: RoleAgent = {
      profileId: "summarizer",
      kind: "codex",
      async openSession(input) {
        openInputs.push(input);
        return session;
      },
    };

    const running = summarizeDiscussion(
      { ...summarizeInput(agent, turns), abortSignal: controller.signal },
      () => "prompt",
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveSend).toBeDefined();
    controller.abort();
    resolveSend?.({
      sessionId: session.sessionId,
      text: jsonFenced(conclusionContent("t-1")),
      events: [],
    });
    const error = await running.catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "cancelled" });
    expect(openInputs[0]?.abortSignal).toBe(controller.signal);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
