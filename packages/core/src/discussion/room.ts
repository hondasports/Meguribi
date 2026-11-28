import type { AgentEvent } from "../agent-event.js";
import type { AgentTurnResult, RoleAgent, RoleSession } from "../role-agent.js";
import { agentDisplayName } from "../role-agent.js";
import type { WorkflowEvent } from "../workflow-engine/events.js";
import {
  buildDiscussionTurnPrompt,
  buildEnvelopeRepairPrompt,
  type DiscussionBrief,
} from "./prompt.js";
import { evaluateDiscussionEnd, pickNextSpeaker, type DiscussionProgress } from "./turn-order.js";
import type {
  DiscussionEndReason,
  DiscussionEnvelope,
  DiscussionLimits,
  DiscussionTurn,
} from "./types.js";

export type EnvelopeParseResult =
  | { ok: true; envelope: DiscussionEnvelope }
  | { ok: false; reason: string };

export interface DiscussionPorts {
  parseEnvelope(text: string): EnvelopeParseResult;
  appendTurn(turn: DiscussionTurn): Promise<void>;
  readHumanMessages(): Promise<readonly { message: string; at: string }[]>;
  onEvent?: (event: WorkflowEvent) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunDiscussionInput {
  runId: string;
  cwd: string;
  artifactRoot: string;
  participants: readonly RoleAgent[];
  brief: DiscussionBrief;
  limits: DiscussionLimits;
  ports: DiscussionPorts;
  abortSignal?: AbortSignal;
}

export interface DiscussionResult {
  turns: readonly DiscussionTurn[];
  endedBy: DiscussionEndReason;
}

const timeoutToken = Symbol("discussion.turn.timeout");
type TimeoutToken = typeof timeoutToken;

interface TimeoutHandle {
  promise: Promise<TimeoutToken>;
  cancel(): void;
}

type SendOutcome = { type: "timeout" } | { type: "success"; result: AgentTurnResult };

function createTimeout(ms: number, sleep?: (ms: number) => Promise<void>): TimeoutHandle {
  if (sleep) {
    let cancelled = false;
    const promise = new Promise<TimeoutToken>((resolve, reject) => {
      void sleep(ms).then(
        () => {
          if (!cancelled) {
            resolve(timeoutToken);
          }
        },
        (error: unknown) => {
          if (!cancelled) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
    });
    return {
      promise,
      cancel() {
        cancelled = true;
      },
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<TimeoutToken>((resolve) => {
    timer = setTimeout(() => resolve(timeoutToken), ms);
  });
  return {
    promise,
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

function discussionCancelledError(): Error & { code: "cancelled" } {
  const error = new Error("discussion cancelled") as Error & { code: "cancelled" };
  error.code = "cancelled";
  return error;
}

interface AbortWatcher {
  promise?: Promise<never>;
  throwIfAborted(): void;
  dispose(): void;
}

function createAbortWatcher(signal: AbortSignal | undefined): AbortWatcher {
  if (!signal) {
    return {
      throwIfAborted() {},
      dispose() {},
    };
  }

  const cancellation = discussionCancelledError();
  let rejectPromise!: (reason: Error & { code: "cancelled" }) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  const abort = () => rejectPromise(cancellation);
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }
  void promise.catch(() => undefined);

  return {
    promise,
    throwIfAborted() {
      if (signal.aborted) {
        throw cancellation;
      }
    },
    dispose() {
      signal.removeEventListener("abort", abort);
    },
  };
}

function latestTurnIndex(turns: readonly DiscussionTurn[], speaker: string): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.speaker === speaker) {
      return index;
    }
  }
  return -1;
}

function humanEnvelope(message: string): DiscussionEnvelope {
  return {
    message,
    replyTo: [],
    addressTo: [],
    positions: [],
    newIssues: [],
    done: false,
  };
}

function malformedEnvelope(text: string): DiscussionEnvelope {
  return {
    message: text.length > 0 ? text : "(empty response)",
    replyTo: [],
    addressTo: [],
    positions: [],
    newIssues: [],
    done: false,
  };
}

function participantLabel(agent: RoleAgent, brief: DiscussionBrief): string {
  return (
    brief.participants.find((participant) => participant.id === agent.profileId)?.label ??
    agentDisplayName(agent.kind)
  );
}

async function closeAllSessions(
  sessions: Map<string, RoleSession>,
): Promise<{ error: unknown } | undefined> {
  const openSessions = [...sessions.values()];
  sessions.clear();
  let failure: { error: unknown } | undefined;
  for (const session of openSessions) {
    try {
      await session.close();
    } catch (error) {
      failure ??= { error };
    }
  }
  return failure;
}

export async function runDiscussion(input: RunDiscussionInput): Promise<DiscussionResult> {
  const now = input.ports.now ?? (() => new Date());
  const participantIds = input.participants.map((participant) => participant.profileId);
  const participantsById = new Map(
    input.participants.map((participant) => [participant.profileId, participant]),
  );
  const sessions = new Map<string, RoleSession>();
  const turns: DiscussionTurn[] = [];
  const consecutiveTimeouts: Record<string, number> = {};
  const startedAt = now().toISOString();
  const abortWatcher = createAbortWatcher(input.abortSignal);
  const abortPromise = abortWatcher.promise;
  let agentTurnCount = 0;
  let result: DiscussionResult | undefined;
  let failed = false;
  let failure: unknown;

  function emit(event: WorkflowEvent): void {
    try {
      input.ports.onEvent?.(event);
    } catch {
      // 進捗表示の例外で議論の結果を変えない
    }
  }

  async function raceWithAbort<T>(promise: Promise<T>): Promise<T> {
    if (!abortPromise) {
      return promise;
    }
    void promise.catch(() => undefined);
    return Promise.race([promise, abortPromise]);
  }

  function progress(): DiscussionProgress {
    return {
      participants: participantIds,
      turns,
      startedAt,
      consecutiveTimeouts,
    };
  }

  async function closeParticipant(profileId: string): Promise<void> {
    const session = sessions.get(profileId);
    if (!session) {
      return;
    }
    sessions.delete(profileId);
    await session.close();
  }

  async function openParticipantSession(
    agent: RoleAgent,
  ): Promise<{ session: RoleSession; isNewSession: boolean }> {
    const existing = sessions.get(agent.profileId);
    if (existing) {
      return { session: existing, isNewSession: false };
    }

    const onEvent = input.ports.onEvent
      ? (event: AgentEvent) => {
          emit({
            type: "agent.event",
            stepId: "discuss",
            profileId: agent.profileId,
            agentLabel: participantLabel(agent, input.brief),
            role: "discussant",
            event,
          });
        }
      : undefined;
    const opening = agent.openSession({
      cwd: input.cwd,
      mode: "read-only",
      role: "discussant",
      artifactRoot: `${input.artifactRoot}/${agent.profileId}`,
      abortSignal: input.abortSignal,
      onEvent,
    });
    let session: RoleSession;
    try {
      session = await raceWithAbort(opening);
    } catch (error) {
      void opening
        .then((lateSession) => {
          void lateSession.close().catch(() => undefined);
        })
        .catch(() => undefined);
      throw error;
    }
    sessions.set(agent.profileId, session);
    return { session, isNewSession: true };
  }

  async function sendWithTimeout(session: RoleSession, prompt: string): Promise<SendOutcome> {
    const sendPromise = session.send({ content: prompt });
    void sendPromise.catch(() => undefined);
    const timeout = createTimeout(input.limits.turnTimeoutMs, input.ports.sleep);
    try {
      const raced = await raceWithAbort(Promise.race([sendPromise, timeout.promise]));
      if (raced === timeoutToken) {
        return { type: "timeout" };
      }
      return { type: "success", result: raced };
    } finally {
      timeout.cancel();
    }
  }

  async function sendOrRethrow(
    session: RoleSession,
    prompt: string,
    agent: RoleAgent,
  ): Promise<SendOutcome> {
    try {
      return await sendWithTimeout(session, prompt);
    } catch (error) {
      await closeParticipant(agent.profileId).catch(() => undefined);
      throw error;
    }
  }

  async function recordTurn(turn: DiscussionTurn): Promise<void> {
    await raceWithAbort(input.ports.appendTurn(turn));
    turns.push(turn);
    emit({
      type: "discussion.turn",
      runId: input.runId,
      turn,
      turnNumber: agentTurnCount,
      maxTurns: input.limits.maxTurns,
    });
  }

  function nextTurnId(): string {
    return `t-${String(turns.length + 1)}`;
  }

  try {
    abortWatcher.throwIfAborted();
    while (true) {
      const humanMessages = await raceWithAbort(input.ports.readHumanMessages());
      for (const humanMessage of humanMessages) {
        const turn: DiscussionTurn = {
          turnId: nextTurnId(),
          speaker: "human",
          speakerLabel: "あなた",
          envelope: humanEnvelope(humanMessage.message),
          malformed: false,
          at: humanMessage.at,
        };
        await recordTurn(turn);
      }

      abortWatcher.throwIfAborted();
      const endedBy = evaluateDiscussionEnd(progress(), input.limits, now());
      if (endedBy !== undefined) {
        emit({
          type: "discussion.ended",
          runId: input.runId,
          endedBy,
          turns: turns.length,
          at: now().toISOString(),
        });
        result = { turns: [...turns], endedBy };
        break;
      }

      const speaker = pickNextSpeaker(progress());
      const agent = participantsById.get(speaker);
      if (!agent) {
        throw new Error(`discussion participant not found: ${speaker}`);
      }
      const { session, isNewSession } = await openParticipantSession(agent);
      const sinceTurnIndex = isNewSession ? 0 : latestTurnIndex(turns, speaker) + 1;
      const prompt = buildDiscussionTurnPrompt({
        brief: input.brief,
        self: speaker,
        transcript: turns,
        sinceTurnIndex,
        limits: input.limits,
        turnNumber: agentTurnCount + 1,
      });

      const first = await sendOrRethrow(session, prompt, agent);
      if (first.type === "timeout") {
        consecutiveTimeouts[speaker] = (consecutiveTimeouts[speaker] ?? 0) + 1;
        await closeParticipant(speaker);
        continue;
      }

      let rawText = first.result.text;
      let parseResult = input.ports.parseEnvelope(rawText);
      if (!parseResult.ok) {
        const repair = await sendOrRethrow(
          session,
          buildEnvelopeRepairPrompt(parseResult.reason),
          agent,
        );
        if (repair.type === "timeout") {
          consecutiveTimeouts[speaker] = (consecutiveTimeouts[speaker] ?? 0) + 1;
          await closeParticipant(speaker);
          continue;
        }
        rawText = repair.result.text;
        parseResult = input.ports.parseEnvelope(rawText);
      }

      consecutiveTimeouts[speaker] = 0;
      const malformed = !parseResult.ok;
      const envelope = parseResult.ok ? parseResult.envelope : malformedEnvelope(rawText);
      agentTurnCount += 1;
      const turn: DiscussionTurn = {
        turnId: nextTurnId(),
        speaker,
        speakerLabel: participantLabel(agent, input.brief),
        envelope,
        malformed,
        at: now().toISOString(),
      };
      await recordTurn(turn);
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  abortWatcher.dispose();
  const closeFailure = await closeAllSessions(sessions).catch((error: unknown) => ({ error }));
  if (failed) {
    throw failure;
  }
  if (closeFailure) {
    throw closeFailure.error;
  }
  if (!result) {
    throw new Error("discussion finished without a result");
  }
  return result;
}
