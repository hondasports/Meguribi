import type { DiscussionMcpPolicy } from "./consultation-api.js";

export function consultationTitle(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return "相談";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export function consultationPromptForDisplay(input: {
  persistedPrompt?: string | null;
  localPrompt?: string | null;
}): string | null {
  if (typeof input.persistedPrompt === "string" && input.persistedPrompt.trim().length > 0) {
    return input.persistedPrompt;
  }
  if (typeof input.localPrompt === "string" && input.localPrompt.trim().length > 0) {
    return input.localPrompt;
  }
  return null;
}

export function isConsultationCommand(command: string): boolean {
  return command === "consult" || command === "discuss";
}

export function initialDiscussionMcpPolicy(): DiscussionMcpPolicy {
  return "deny";
}

export function discussionMcpPolicyAfterSubmit(): DiscussionMcpPolicy {
  return "deny";
}
