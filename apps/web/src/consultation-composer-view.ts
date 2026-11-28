import type { DiscussionProfile } from "./consultation-api.js";

export function isProfileAvailable(profile: DiscussionProfile): boolean {
  return profile.available;
}

export function availableDefaultProfileIds(
  defaultProfileIds: readonly string[],
  profiles: readonly DiscussionProfile[],
): string[] {
  const availableIds = new Set(
    profiles.filter((profile) => isProfileAvailable(profile)).map((profile) => profile.id),
  );
  return defaultProfileIds.filter((id) => availableIds.has(id));
}

export function participantAvailabilityError(
  profiles: readonly DiscussionProfile[],
  loadError: string | null,
): string | null {
  if (loadError !== null) return `参加CLI候補を取得できませんでした。${loadError}`;
  const count = profiles.filter((profile) => isProfileAvailable(profile)).length;
  if (count < 2) {
    return `利用可能な参加CLIが2件未満のため相談を開始できません（現在${String(count)}件）。CLI設定を確認してください。`;
  }
  return null;
}

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
