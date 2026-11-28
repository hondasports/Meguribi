export type DiscussionSpeakerKind = "agent" | "human" | "system";

export interface SpeakerVisual {
  initials: string;
  kind: DiscussionSpeakerKind;
  kindLabel: string;
}

export function speakerVisual(speaker: string, speakerLabel: string): SpeakerVisual {
  const normalizedSpeaker = speaker.trim().toLowerCase();
  const kind: DiscussionSpeakerKind =
    normalizedSpeaker === "human" || speakerLabel.trim().toLowerCase() === "you"
      ? "human"
      : normalizedSpeaker === "system"
        ? "system"
        : "agent";
  const words = (kind === "human" ? speakerLabel.trim().toLowerCase() : normalizedSpeaker).split(
    /[^a-z0-9]+/,
  ).filter(Boolean);
  const initials =
    words.length > 0
      ? words
          .slice(0, 2)
          .map((word) => word[0]?.toUpperCase() ?? "")
          .join("")
      : speakerLabel.trim().slice(0, 1).toUpperCase() || "?";
  return {
    initials,
    kind,
    kindLabel: kind === "human" ? "You" : kind === "system" ? "System" : "Agent",
  };
}

export interface ScrollPosition {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function shouldStickToBottom(position: ScrollPosition, threshold = 96): boolean {
  if (position.scrollHeight <= position.clientHeight) return true;
  const distanceFromBottom =
    position.scrollHeight - position.clientHeight - Math.max(0, position.scrollTop);
  return distanceFromBottom <= threshold;
}

export function shouldAutoScrollAfterAppend(input: {
  previousCount: number;
  nextCount: number;
  wasAtBottom: boolean;
}): boolean {
  if (input.nextCount <= input.previousCount) return false;
  return input.previousCount === 0 || input.wasAtBottom;
}
