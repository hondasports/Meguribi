import type { DiscussionProfile } from "./consultation-api.js";

export function participantToolbarSummary(
  selectedIds: readonly string[],
  profiles: readonly DiscussionProfile[],
): string {
  if (selectedIds.length === 0) return "参加CLIを選ぶ";
  const labels = selectedIds.map(
    (id) => profiles.find((profile) => profile.id === id)?.label ?? id,
  );
  return labels.join("・");
}

export function shouldOpenOptionsForValidation(error: string | null): boolean {
  return error === "参加エージェントを2〜4件選んでください";
}
