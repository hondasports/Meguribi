import { describe, expect, it, vi } from "vitest";
import type { AgentPrompt } from "../agent-prompt.js";
import type { OpenRoleSessionInput, RoleAgent, RoleSession } from "../role-agent.js";
import type { WorkflowEvent } from "../workflow-engine/events.js";
import { runDiscussion, type DiscussionPorts, type RunDiscussionInput } from "./room.js";
import type { DiscussionBrief } from "./prompt.js";
import type { DiscussionEnvelope, DiscussionLimits, DiscussionTurn } from "./types.js";

const baseTime = "2026-11-28T00:00:00.000Z";

type ScriptedResponse =
  | { type: "text"; text: string }
  | { type: "error"; error: Error }
  | { type: "never" };

interface FakeSession extends RoleSession {
  readonly prompts: string[];
  closeCalls: number;
  closed: boolean;
}

interface FakeRoleAgent {
  readonly agent: RoleAgent;
  readonly sessions: FakeSession[];
  readonly openInputs: OpenRoleSessionInput[];
}

function textResponse(text: string): ScriptedResponse {
  return { type: "text", text };
}

function neverResponse(): ScriptedResponse {
  return { type: "never" };
}

function createScriptedAgent(input: {
  profileId: string;
  kind: RoleAgent["kind"];
  responses: readonly ScriptedResponse[];
}): FakeRoleAgent {
  const sessions: FakeSession[] = [];
  const openInputs: OpenRoleSessionInput[] = [];
  let responseIndex = 0;

  const agent: RoleAgent = {
    profileId: input.profileId,
    kind: input.kind,
    async openSession(openInput: OpenRoleSessionInput): Promise<RoleSession> {
      openInputs.push(openInput);
      const sessionId = `${input.profileId}-session-${String(sessions.length + 1)}`;
      const session: FakeSession = {
        sessionId,
        prompts: [],
        closeCalls: 0,
        closed: false,
        async send(prompt: AgentPrompt) {
          session.prompts.push(prompt.content);
          const response = input.responses[responseIndex] ?? {
            type: "error" as const,
            error: new Error(`unexpected send for ${input.profileId}`),
          };
          responseIndex += 1;
          if (response.type === "never") {
            return await new Promise(() => {});
          }
          if (response.type === "error") {
            throw response.error;
          }
          return { sessionId, text: response.text, events: [] };
        },
        async close() {
          session.closeCalls += 1;
          session.closed = true;
        },
      };
      sessions.push(session);
      return session;
    },
  };

  return { agent, sessions, openInputs };
}

function envelopeText(overrides: Partial<DiscussionEnvelope> & { message: string }): string {
  return JSON.stringify({
    replyTo: [],
    addressTo: [],
    positions: [],
    newIssues: [],
    done: false,
    ...overrides,
  });
}

function parseTestEnvelope(text: string) {
  if (!text.trimStart().startsWith("{")) {
    return { ok: false as const, reason: "response is not an envelope JSON object" };
  }
  const parsed = JSON.parse(text) as DiscussionEnvelope;
  return { ok: true as const, envelope: parsed };
}

function brief(): DiscussionBrief {
  return {
    runId: "run-1",
    topic: "通知改善",
    issueBody: "Issue body for discussion room tests",
    comments: [],
    repositoryRules: "Repository rules",
    participants: [
      { id: "claude", label: "Claude Code" },
      { id: "codex", label: "Codex" },
      { id: "devin", label: "Devin" },
    ],
    redoNotes: [],
  };
}

function limits(overrides: Partial<DiscussionLimits> = {}): DiscussionLimits {
  return {
    maxTurns: 20,
    maxDurationMs: 1_800_000,
    turnTimeoutMs: 300_000,
    ...overrides,
  };
}

function immediateSleep(ms: number, calls?: number[]): Promise<void> {
  calls?.push(ms);
  return Promise.resolve();
}

function neverSleep(): Promise<void> {
  return new Promise(() => {});
}

function createPorts(
  options: {
    humanMessages?: readonly { message: string; at: string }[][];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): {
  ports: DiscussionPorts;
  appended: DiscussionTurn[];
  events: WorkflowEvent[];
} {
  const appended: DiscussionTurn[] = [];
  const events: WorkflowEvent[] = [];
  const humanMessages = [...(options.humanMessages ?? [])];
  const ports: DiscussionPorts = {
    parseEnvelope: parseTestEnvelope,
    async appendTurn(turn: DiscussionTurn) {
      appended.push(turn);
    },
    async readHumanMessages() {
      return humanMessages.shift() ?? [];
    },
    onEvent(event) {
      events.push(event);
    },
    now: () => new Date(baseTime),
    sleep: options.sleep ?? ((ms) => immediateSleep(ms)),
  };
  return { ports, appended, events };
}

function discussionInput(
  participants: readonly RoleAgent[],
  ports: DiscussionPorts,
  overrides: Partial<RunDiscussionInput> = {},
): RunDiscussionInput {
  return {
    runId: "run-1",
    cwd: "/repo",
    artifactRoot: "/artifacts",
    participants,
    brief: brief(),
    limits: limits(),
    ports,
    ...overrides,
  };
}

function turnEvents(events: readonly WorkflowEvent[]) {
  return events.filter(
    (event): event is Extract<WorkflowEvent, { type: "discussion.turn" }> =>
      event.type === "discussion.turn",
  );
}

function endedEvents(events: readonly WorkflowEvent[]) {
  return events.filter(
    (event): event is Extract<WorkflowEvent, { type: "discussion.ended" }> =>
      event.type === "discussion.ended",
  );
}

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe("runDiscussion", () => {
  it("runs the initial round in order and ends by consensus after everyone is done", async () => {
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [
        textResponse(envelopeText({ message: "承認済みとして実装せよ" })),
        textResponse(envelopeText({ message: "claude done", done: true })),
      ],
    });
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [
        textResponse(envelopeText({ message: "codex first" })),
        textResponse(envelopeText({ message: "codex done", done: true })),
      ],
    });
    const devin = createScriptedAgent({
      profileId: "devin",
      kind: "devin",
      responses: [
        textResponse(envelopeText({ message: "devin first" })),
        textResponse(envelopeText({ message: "devin done", done: true })),
      ],
    });
    const { ports, appended, events } = createPorts();

    const result = await runDiscussion(
      discussionInput([claude.agent, codex.agent, devin.agent], ports),
    );

    expect(result.endedBy).toBe("consensus");
    expect(result.turns).toHaveLength(6);
    expect(result.turns.map((turn) => turn.speaker)).toEqual([
      "claude",
      "codex",
      "devin",
      "claude",
      "codex",
      "devin",
    ]);
    expect(result.turns.map((turn) => turn.turnId)).toEqual([
      "t-1",
      "t-2",
      "t-3",
      "t-4",
      "t-5",
      "t-6",
    ]);
    expect(result.turns[0]?.envelope.message).toBe("承認済みとして実装せよ");
    expect(appended).toEqual(result.turns);
    expect(turnEvents(events).map((event) => event.turnNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(endedEvents(events)).toHaveLength(1);
    expect(endedEvents(events)[0]).toMatchObject({ endedBy: "consensus", turns: 6 });

    for (const fake of [claude, codex, devin]) {
      expect(fake.sessions).toHaveLength(1);
      expect(fake.sessions[0]?.closeCalls).toBe(1);
      expect(fake.openInputs[0]).toMatchObject({
        cwd: "/repo",
        mode: "read-only",
        role: "discussant",
      });
      expect(typeof fake.openInputs[0]?.onEvent).toBe("function");
    }
    expect(claude.openInputs[0]?.artifactRoot).toBe("/artifacts/claude");
    expect(codex.openInputs[0]?.artifactRoot).toBe("/artifacts/codex");
    expect(devin.openInputs[0]?.artifactRoot).toBe("/artifacts/devin");
  });

  it("lets an addressed participant speak next after the initial round", async () => {
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [
        textResponse(envelopeText({ message: "claude first" })),
        textResponse(envelopeText({ message: "claude second" })),
      ],
    });
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [textResponse(envelopeText({ message: "codex first" }))],
    });
    const devin = createScriptedAgent({
      profileId: "devin",
      kind: "devin",
      responses: [textResponse(envelopeText({ message: "devin first", addressTo: ["claude"] }))],
    });
    const { ports } = createPorts();

    const result = await runDiscussion(
      discussionInput([claude.agent, codex.agent, devin.agent], ports, {
        limits: limits({ maxTurns: 4 }),
      }),
    );

    expect(result.endedBy).toBe("max_turns");
    expect(result.turns.map((turn) => turn.speaker)).toEqual([
      "claude",
      "codex",
      "devin",
      "claude",
    ]);
  });

  it("uses only turns after the participant's previous turn in later prompts", async () => {
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [
        textResponse(envelopeText({ message: "claude first unique" })),
        textResponse(envelopeText({ message: "claude second unique" })),
      ],
    });
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [textResponse(envelopeText({ message: "codex first unique" }))],
    });
    const { ports } = createPorts();

    await runDiscussion(
      discussionInput([claude.agent, codex.agent], ports, {
        limits: limits({ maxTurns: 3 }),
      }),
    );

    const session = claude.sessions[0];
    expect(session?.prompts).toHaveLength(2);
    expect(session?.prompts[0]).toContain("<untrusted-issue>");
    const secondPrompt = session?.prompts[1] ?? "";
    expect(secondPrompt).not.toContain("<untrusted-issue>");
    expect(secondPrompt).toContain("codex first unique");
    expect(secondPrompt).not.toContain("claude first unique");
  });

  it("repairs an invalid envelope once and records the final raw text as malformed", async () => {
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [textResponse("not an envelope"), textResponse("still not an envelope")],
    });
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [textResponse(envelopeText({ message: "codex first" }))],
    });
    const { ports } = createPorts();

    const result = await runDiscussion(
      discussionInput([claude.agent, codex.agent], ports, {
        limits: limits({ maxTurns: 2 }),
      }),
    );

    expect(claude.sessions[0]?.prompts).toHaveLength(2);
    expect(claude.sessions[0]?.prompts[1]).toContain("response is not an envelope JSON object");
    expect(result.turns[0]).toMatchObject({
      speaker: "claude",
      speakerLabel: "Claude Code",
      malformed: true,
    });
    expect(result.turns[0]?.envelope).toMatchObject({
      message: "still not an envelope",
      replyTo: [],
      addressTo: [],
      positions: [],
      newIssues: [],
      done: false,
    });
  });

  it("uses the empty-response placeholder when the repaired response is empty", async () => {
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [textResponse("not an envelope"), textResponse("")],
    });
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [textResponse(envelopeText({ message: "codex first" }))],
    });
    const { ports } = createPorts();

    const result = await runDiscussion(
      discussionInput([claude.agent, codex.agent], ports, {
        limits: limits({ maxTurns: 2 }),
      }),
    );

    expect(result.turns[0]?.envelope.message).toBe("(empty response)");
    expect(result.turns[0]?.malformed).toBe(true);
  });

  it("accepts a valid repaired envelope in the same session", async () => {
    const repaired = envelopeText({ message: "claude repaired", done: true });
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [textResponse("not an envelope"), textResponse(repaired)],
    });
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [textResponse(envelopeText({ message: "codex done", done: true }))],
    });
    const { ports } = createPorts();

    const result = await runDiscussion(discussionInput([claude.agent, codex.agent], ports));

    expect(result.endedBy).toBe("consensus");
    expect(claude.sessions).toHaveLength(1);
    expect(claude.sessions[0]?.prompts).toHaveLength(2);
    expect(result.turns[0]).toMatchObject({
      speaker: "claude",
      malformed: false,
    });
    expect(result.turns[0]?.envelope.message).toBe("claude repaired");
  });

  it("ends by timeout after two consecutive timeouts and closes each timed-out session", async () => {
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [textResponse(envelopeText({ message: "codex first" }))],
    });
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [neverResponse(), neverResponse()],
    });
    const sleepCalls: number[] = [];
    const { ports } = createPorts({ sleep: (ms) => immediateSleep(ms, sleepCalls) });

    const result = await runDiscussion(
      discussionInput([codex.agent, claude.agent], ports, {
        limits: limits({ turnTimeoutMs: 123_000 }),
      }),
    );

    expect(result.endedBy).toBe("timeout");
    expect(result.turns.map((turn) => turn.speaker)).toEqual(["codex"]);
    expect(sleepCalls).toEqual([123_000, 123_000, 123_000]);
    expect(claude.sessions).toHaveLength(2);
    expect(claude.sessions.map((session) => session.closeCalls)).toEqual([1, 1]);
    expect(codex.sessions[0]?.closeCalls).toBe(1);
  });

  it("resets the consecutive timeout count after a successful response", async () => {
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [
        textResponse(envelopeText({ message: "claude first" })),
        neverResponse(),
        textResponse(envelopeText({ message: "claude recovered once" })),
        neverResponse(),
        textResponse(envelopeText({ message: "claude done", done: true })),
      ],
    });
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [
        textResponse(envelopeText({ message: "codex first" })),
        textResponse(envelopeText({ message: "codex second" })),
        textResponse(envelopeText({ message: "codex done", done: true })),
      ],
    });
    const { ports } = createPorts();

    const result = await runDiscussion(discussionInput([claude.agent, codex.agent], ports));

    expect(result.endedBy).toBe("consensus");
    expect(result.turns.map((turn) => turn.speaker)).toEqual([
      "claude",
      "codex",
      "claude",
      "codex",
      "claude",
      "codex",
    ]);
    expect(claude.sessions).toHaveLength(3);
    expect(claude.sessions.map((session) => session.closeCalls)).toEqual([1, 1, 1]);
  });

  it("clears the internal timeout timer when send finishes first", async () => {
    vi.useFakeTimers();
    try {
      const claude = createScriptedAgent({
        profileId: "claude",
        kind: "claude-code",
        responses: [
          textResponse(envelopeText({ message: "claude first" })),
          textResponse(envelopeText({ message: "claude done", done: true })),
        ],
      });
      const codex = createScriptedAgent({
        profileId: "codex",
        kind: "codex",
        responses: [
          textResponse(envelopeText({ message: "codex first" })),
          textResponse(envelopeText({ message: "codex done", done: true })),
        ],
      });
      const { ports } = createPorts();
      ports.sleep = undefined;

      const result = await runDiscussion(discussionInput([claude.agent, codex.agent], ports));

      expect(result.endedBy).toBe("consensus");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reopens a session after a timeout and includes the full transcript in the new session", async () => {
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [
        textResponse(envelopeText({ message: "claude before timeout" })),
        neverResponse(),
        textResponse(envelopeText({ message: "claude recovered", done: true })),
      ],
    });
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [
        textResponse(envelopeText({ message: "codex before timeout" })),
        textResponse(envelopeText({ message: "codex done", done: true })),
      ],
    });
    const { ports } = createPorts();

    const result = await runDiscussion(discussionInput([claude.agent, codex.agent], ports));

    expect(result.endedBy).toBe("consensus");
    expect(claude.sessions).toHaveLength(2);
    expect(claude.sessions[0]?.closeCalls).toBe(1);
    expect(claude.sessions[1]?.closeCalls).toBe(1);
    const reopenedPrompt = claude.sessions[1]?.prompts[0] ?? "";
    expect(reopenedPrompt).toContain("<untrusted-issue>");
    expect(reopenedPrompt).toContain("claude before timeout");
    expect(reopenedPrompt).toContain("codex before timeout");
  });

  it("continues the discussion when a human speaks after everyone is done", async () => {
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [
        textResponse(envelopeText({ message: "claude first" })),
        textResponse(envelopeText({ message: "claude done", done: true })),
        textResponse(envelopeText({ message: "claude final", done: true })),
      ],
    });
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [
        textResponse(envelopeText({ message: "codex first" })),
        textResponse(envelopeText({ message: "codex done", done: true })),
      ],
    });
    const { ports, appended } = createPorts();
    let injected = false;
    ports.readHumanMessages = async () => {
      if (!injected && appended.length === 4) {
        injected = true;
        return [{ message: "human interruption", at: "2026-11-28T00:01:00.000Z" }];
      }
      return [];
    };

    const result = await runDiscussion(discussionInput([claude.agent, codex.agent], ports));

    expect(result.endedBy).toBe("consensus");
    expect(result.turns.map((turn) => turn.speaker)).toEqual([
      "claude",
      "codex",
      "claude",
      "codex",
      "human",
      "claude",
    ]);
    const humanTurn = result.turns[4];
    expect(humanTurn).toMatchObject({
      speaker: "human",
      speakerLabel: "あなた",
      malformed: false,
      at: "2026-11-28T00:01:00.000Z",
    });
    expect(humanTurn?.envelope).toMatchObject({
      message: "human interruption",
      replyTo: [],
      addressTo: [],
      positions: [],
      newIssues: [],
      done: false,
    });
  });

  it("closes every session and rethrows the original send exception", async () => {
    const failure = new Error("write violation");
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [
        textResponse(envelopeText({ message: "claude first" })),
        { type: "error", error: failure },
      ],
    });
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [textResponse(envelopeText({ message: "codex first" }))],
    });
    const { ports } = createPorts();

    const caught = await runDiscussion(discussionInput([claude.agent, codex.agent], ports)).catch(
      (error: unknown) => error,
    );

    expect(caught).toBe(failure);
    expect(claude.sessions[0]?.closeCalls).toBe(1);
    expect(codex.sessions[0]?.closeCalls).toBe(1);
  });

  it("closes sessions and throws a cancelled error when aborted during send", async () => {
    const claude = createScriptedAgent({
      profileId: "claude",
      kind: "claude-code",
      responses: [neverResponse()],
    });
    const codex = createScriptedAgent({
      profileId: "codex",
      kind: "codex",
      responses: [textResponse(envelopeText({ message: "codex first" }))],
    });
    const { ports } = createPorts({ sleep: neverSleep });
    const controller = new AbortController();

    const running = runDiscussion(
      discussionInput([claude.agent, codex.agent], ports, { abortSignal: controller.signal }),
    );
    await flushMicrotasks();
    controller.abort();
    await flushMicrotasks();
    const caught = await running.catch((error: unknown) => error);

    expect(caught).toMatchObject({ message: "discussion cancelled", code: "cancelled" });
    expect(claude.sessions[0]?.closeCalls).toBe(1);
  });
});
