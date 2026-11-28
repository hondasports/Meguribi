import type { DiscussionEndReason, DiscussionLimits, DiscussionTurn } from "./types.js";

export interface DiscussionProgress {
  participants: readonly string[];
  turns: readonly DiscussionTurn[];
  startedAt: string;
  consecutiveTimeouts: Readonly<Record<string, number>>;
}

function isAgentTurn(participants: readonly string[], turn: DiscussionTurn): boolean {
  return turn.speaker !== "human" && participants.includes(turn.speaker);
}

function latestTurnIndex(turns: readonly DiscussionTurn[], speaker: string): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.speaker === speaker) {
      return index;
    }
  }
  return -1;
}

function previousAgentTurn(progress: DiscussionProgress): DiscussionTurn | undefined {
  for (let index = progress.turns.length - 1; index >= 0; index -= 1) {
    const turn = progress.turns[index];
    if (turn && isAgentTurn(progress.participants, turn)) {
      return turn;
    }
  }
  return undefined;
}

export function pickNextSpeaker(progress: DiscussionProgress): string {
  const [firstParticipant] = progress.participants;
  if (!firstParticipant) {
    throw new Error("discussion participants must not be empty");
  }

  const spoken = new Set(
    progress.turns
      .filter((turn) => isAgentTurn(progress.participants, turn))
      .map((turn) => turn.speaker),
  );
  for (const participant of progress.participants) {
    if (!spoken.has(participant)) {
      return participant;
    }
  }

  const previous = previousAgentTurn(progress);
  if (!previous) {
    return firstParticipant;
  }

  for (const addressee of previous.envelope.addressTo) {
    if (addressee !== previous.speaker && progress.participants.includes(addressee)) {
      return addressee;
    }
  }

  const candidates = progress.participants.filter(
    (participant) => participant !== previous.speaker,
  );
  if (candidates.length === 0) {
    return previous.speaker;
  }

  let selected = candidates[0] ?? previous.speaker;
  let oldestTurnIndex = latestTurnIndex(progress.turns, selected);
  for (const candidate of candidates.slice(1)) {
    const candidateTurnIndex = latestTurnIndex(progress.turns, candidate);
    if (candidateTurnIndex < oldestTurnIndex) {
      selected = candidate;
      oldestTurnIndex = candidateTurnIndex;
    }
  }
  return selected;
}

export function evaluateDiscussionEnd(
  progress: DiscussionProgress,
  limits: DiscussionLimits,
  now: Date,
): DiscussionEndReason | undefined {
  for (const participant of progress.participants) {
    if ((progress.consecutiveTimeouts[participant] ?? 0) >= 2) {
      return "timeout";
    }
  }

  let agentTurnCount = 0;
  const latestAgentTurnIndexes = new Map<string, number>();
  for (let index = 0; index < progress.turns.length; index += 1) {
    const turn = progress.turns[index];
    if (turn && isAgentTurn(progress.participants, turn)) {
      agentTurnCount += 1;
      latestAgentTurnIndexes.set(turn.speaker, index);
    }
  }

  if (agentTurnCount >= limits.maxTurns) {
    return "max_turns";
  }

  if (now.getTime() - Date.parse(progress.startedAt) >= limits.maxDurationMs) {
    return "max_duration";
  }

  let newestRequiredTurnIndex = -1;
  for (const participant of progress.participants) {
    const turnIndex = latestAgentTurnIndexes.get(participant);
    if (turnIndex === undefined) {
      return undefined;
    }
    const turn = progress.turns[turnIndex];
    if (!turn?.envelope.done) {
      return undefined;
    }
    newestRequiredTurnIndex = Math.max(newestRequiredTurnIndex, turnIndex);
  }

  for (let index = newestRequiredTurnIndex + 1; index < progress.turns.length; index += 1) {
    if (progress.turns[index]?.speaker === "human") {
      return undefined;
    }
  }

  return "consensus";
}
