import { watch, type Ref } from "vue";
import type { TerminalRow } from "./terminal-contract.js";

export interface TerminalProfileOption {
  id: string;
  label: string;
}

export interface TerminalScrollPosition {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export const TERMINAL_BOTTOM_THRESHOLD_PX = 24;

export function terminalProfileOptions(rows: readonly TerminalRow[]): TerminalProfileOption[] {
  const options: TerminalProfileOption[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.profileId)) continue;
    seen.add(row.profileId);
    options.push({ id: row.profileId, label: row.label });
  }
  return options;
}

export function filterTerminalRows(
  rows: readonly TerminalRow[],
  profileId: string | null,
): TerminalRow[] {
  return profileId === null ? [...rows] : rows.filter((row) => row.profileId === profileId);
}

export function countRowsAfterLastSeen(
  rows: readonly TerminalRow[],
  lastSeenRowId: string | null,
): number {
  if (lastSeenRowId === null) return rows.length;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.id === lastSeenRowId) return rows.length - index - 1;
  }
  // bounded snapshot では lastSeen が古い行として脱落することがある。
  // その場合は現在の snapshot 全体が未読側なので 0 へ潰さない。
  return rows.length;
}

export function isNearTerminalBottom(position: TerminalScrollPosition): boolean {
  return (
    position.scrollHeight - position.scrollTop - position.clientHeight <=
    TERMINAL_BOTTOM_THRESHOLD_PX
  );
}

export function speakerColorIndex(profileId: string, paletteSize = 6): number {
  let hash = 2166136261;
  for (const char of profileId) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % paletteSize;
}

export function formatTerminalTime(at: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(at));
}

export function terminalKindVisual(kind: TerminalRow["kind"]): {
  symbol: string;
  label: string;
} {
  if (kind === "tool") return { symbol: "$", label: "ツール" };
  if (kind === "status") return { symbol: "›", label: "状態" };
  return { symbol: "│", label: "本文" };
}

export function shouldRestoreBottomOnCollapseChange(
  wasCollapsed: boolean,
  isCollapsed: boolean,
): boolean {
  return wasCollapsed && !isCollapsed;
}

export function terminalScrollBehavior(prefersReducedMotion: boolean): "auto" | "smooth" {
  return prefersReducedMotion ? "auto" : "smooth";
}

export function shouldAutoFollowTerminal(input: { paused: boolean; following: boolean }): boolean {
  return !input.paused && input.following;
}

export function watchTerminalAutoFollow(input: {
  rows: Readonly<Ref<readonly TerminalRow[]>>;
  paused: Readonly<Ref<boolean>>;
  following: Readonly<Ref<boolean>>;
  follow: () => void;
}): void {
  watch(
    () => [input.rows.value, input.paused.value, input.following.value] as const,
    () => {
      if (
        shouldAutoFollowTerminal({ paused: input.paused.value, following: input.following.value })
      ) {
        input.follow();
      }
    },
    { flush: "post", immediate: true },
  );
}
