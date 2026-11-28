import { nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import type { TerminalRow } from "./terminal-contract.js";
import {
  countRowsAfterLastSeen,
  filterTerminalRows,
  formatTerminalTime,
  shouldAutoFollowTerminal,
  shouldRestoreBottomOnCollapseChange,
  terminalKindVisual,
  terminalScrollBehavior,
  watchTerminalAutoFollow,
  isNearTerminalBottom,
  speakerColorIndex,
  terminalProfileOptions,
} from "./terminal-view.js";

function row(id: string, profileId = "devin", label = "Devin CLI"): TerminalRow {
  return {
    id,
    at: `2026-11-28T10:00:${id.padStart(2, "0")}Z`,
    profileId,
    label,
    kind: "message",
    text: `text ${id}`,
    active: false,
  };
}

describe("terminal view helpers", () => {
  it("collects unique CLI options in first-seen order with display labels", () => {
    const rows = [
      row("1", "devin", "Devin CLI"),
      row("2", "claude", "Claude Code"),
      row("3", "devin", "Devin CLI"),
    ];
    expect(terminalProfileOptions(rows)).toEqual([
      { id: "devin", label: "Devin CLI" },
      { id: "claude", label: "Claude Code" },
    ]);
  });

  it("filters rows by CLI and keeps all rows when no filter is selected", () => {
    const rows = [row("1", "devin"), row("2", "claude", "Claude Code")];
    expect(filterTerminalRows(rows, null)).toHaveLength(2);
    expect(filterTerminalRows(rows, "claude").map((item) => item.id)).toEqual(["2"]);
  });

  it("counts only rows appended after the last seen row", () => {
    const rows = [row("1"), row("2"), row("3"), row("4")];
    expect(countRowsAfterLastSeen(rows, "2")).toBe(2);
    expect(countRowsAfterLastSeen(rows, "4")).toBe(0);
    expect(countRowsAfterLastSeen(rows, null)).toBe(4);
    expect(countRowsAfterLastSeen(rows, "dropped-by-bounded-snapshot")).toBe(4);
  });

  it("detects bottom with a compact terminal threshold", () => {
    expect(isNearTerminalBottom({ scrollTop: 176, clientHeight: 120, scrollHeight: 300 })).toBe(
      true,
    );
    expect(isNearTerminalBottom({ scrollTop: 100, clientHeight: 120, scrollHeight: 300 })).toBe(
      false,
    );
  });

  it("auto-follows only when neither manually paused nor scrolled away", () => {
    expect(shouldAutoFollowTerminal({ paused: false, following: true })).toBe(true);
    expect(shouldAutoFollowTerminal({ paused: true, following: true })).toBe(false);
    expect(shouldAutoFollowTerminal({ paused: false, following: false })).toBe(false);
  });

  it("drives the actual auto-follow watcher on same-id growth and stops for pause or scroll-away", async () => {
    const rows = ref<readonly TerminalRow[]>([]);
    const paused = ref(false);
    const following = ref(true);
    const followed: string[] = [];
    watchTerminalAutoFollow({
      rows,
      paused,
      following,
      follow: () => followed.push("follow"),
    });
    await nextTick();
    const initialCalls = followed.length;

    rows.value = [{ ...row("1"), text: "short" }];
    await nextTick();
    expect(followed.length).toBeGreaterThan(initialCalls);

    const afterAppend = followed.length;
    rows.value = [{ ...row("1"), text: "short text that wraps across more terminal lines" }];
    await nextTick();
    expect(followed.length).toBeGreaterThan(afterAppend);

    paused.value = true;
    const beforePauseGrowth = followed.length;
    rows.value = [{ ...row("1"), text: "more growth while paused" }];
    await nextTick();
    expect(followed.length).toBe(beforePauseGrowth);

    paused.value = false;
    following.value = false;
    const beforeScrollAwayGrowth = followed.length;
    rows.value = [{ ...row("1"), text: "more growth while scrolled away" }];
    await nextTick();
    expect(followed.length).toBe(beforeScrollAwayGrowth);
  });

  it("uses terminal symbols with meaningful Japanese accessibility labels", () => {
    expect(terminalKindVisual("message")).toEqual({ symbol: "│", label: "本文" });
    expect(terminalKindVisual("tool")).toEqual({ symbol: "$", label: "ツール" });
    expect(terminalKindVisual("status")).toEqual({ symbol: "›", label: "状態" });
  });

  it("restores the bottom only when folding transitions from closed to open", () => {
    expect(shouldRestoreBottomOnCollapseChange(true, false)).toBe(true);
    expect(shouldRestoreBottomOnCollapseChange(false, true)).toBe(false);
    expect(shouldRestoreBottomOnCollapseChange(false, false)).toBe(false);
  });

  it("never uses smooth scrolling when reduced motion is requested", () => {
    expect(terminalScrollBehavior(true)).toBe("auto");
    expect(terminalScrollBehavior(false)).toBe("smooth");
  });

  it("uses stable speaker colors and short clock labels", () => {
    expect(speakerColorIndex("devin")).toBe(speakerColorIndex("devin"));
    expect(speakerColorIndex("devin")).not.toBe(speakerColorIndex("claude-code"));
    expect(formatTerminalTime("2026-11-28T10:11:12Z", "Asia/Tokyo")).toBe("19:11:12");
  });
});
