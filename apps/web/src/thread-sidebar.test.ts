import { describe, expect, it } from "vitest";
import type { RunSummary } from "../server/run-store-api.js";
import {
  buildThreadItems,
  filterThreadItems,
  moveThreadFocus,
  THREAD_SIDEBAR_LIMIT,
} from "./thread-sidebar.js";

function runFixture(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    repository: "owner/repo",
    issueNumber: 22,
    command: "discuss",
    status: "awaiting_human",
    updatedAt: "2026-11-28T10:00:00.000Z",
    pullRequestNumber: null,
    ...overrides,
  };
}

describe("buildThreadItems", () => {
  it("prefers the persisted prompt title for consultations when available", () => {
    const items = buildThreadItems([
      runFixture({ runId: "c-1", command: "consult", issueNumber: null, title: "通知を減らしたい" }),
    ]);
    expect(items[0]?.title).toBe("通知を減らしたい");
  });

  it("falls back to a stable label when the prompt title is missing", () => {
    const items = buildThreadItems([
      runFixture({ runId: "c-2", command: "consult", issueNumber: null }),
    ]);
    expect(items[0]?.title).toBe("相談");
    const issue = buildThreadItems([runFixture({ runId: "d-1", issueNumber: 42 })]);
    expect(issue[0]?.title).toBe("#42");
  });

  it("builds a subtitle from repository, command and issue identity", () => {
    const items = buildThreadItems([runFixture({ issueNumber: 22 })]);
    expect(items[0]?.subtitle).toContain("owner/repo");
    expect(items[0]?.subtitle).toContain("discuss");
  });

  it("sorts by updatedAt descending and keeps the list count limit", () => {
    const runs = Array.from({ length: THREAD_SIDEBAR_LIMIT + 10 }, (_, index) =>
      runFixture({
        runId: `run-${String(index)}`,
        updatedAt: new Date(1_000_000 + index * 1000).toISOString(),
      }),
    );
    const items = buildThreadItems(runs);
    expect(items).toHaveLength(THREAD_SIDEBAR_LIMIT);
    // 最新が先頭: 最大 index が先頭に来る。
    expect(items[0]?.runId).toBe(`run-${String(THREAD_SIDEBAR_LIMIT + 9)}`);
    for (let index = 1; index < items.length; index += 1) {
      const prev = Date.parse(items[index - 1]!.updatedAt);
      const current = Date.parse(items[index]!.updatedAt);
      expect(prev).toBeGreaterThanOrEqual(current);
    }
  });

  it("exposes the raw status and a human-readable status label", () => {
    const items = buildThreadItems([runFixture({ status: "failed" })]);
    expect(items[0]?.status).toBe("failed");
    expect(items[0]?.statusLabel).toBe("失敗");
  });
});

describe("threadTitle priority in buildThreadItems", () => {
  it("prefers RunSummary.title over the issue-number fallback for issue-backed discussions", () => {
    const items = buildThreadItems([
      runFixture({ issueNumber: 42, title: "仕様の相談タイトル" }),
    ]);
    expect(items[0]?.title).toBe("仕様の相談タイトル");
    expect(items[0]?.title).not.toBe("#42");
  });

  it("ignores a blank RunSummary.title and falls back to the stable label", () => {
    const items = buildThreadItems([
      runFixture({ runId: "c-blank", command: "consult", issueNumber: null, title: "   " }),
    ]);
    expect(items[0]?.title).toBe("相談");
  });
});

describe("filterThreadItems", () => {
  const items = buildThreadItems([
    runFixture({
      runId: "20261128T100000Z-aaaa",
      repository: "acme/api",
      issueNumber: 7,
      title: "通知を減らしたい",
    }),
    runFixture({ runId: "20261128T110000Z-bbbb", repository: "acme/web", issueNumber: 9 }),
  ]);

  it("returns every item for a blank query", () => {
    expect(filterThreadItems(items, "  ")).toHaveLength(2);
  });

  it("matches titles case-insensitively", () => {
    const result = filterThreadItems(items, "通知");
    expect(result).toHaveLength(1);
    expect(result[0]?.runId).toBe("20261128T100000Z-aaaa");
  });

  it("matches run identifiers and repository names", () => {
    expect(filterThreadItems(items, "bbbb")).toHaveLength(1);
    expect(filterThreadItems(items, "acme/web")).toHaveLength(1);
    expect(filterThreadItems(items, "ACME")).toHaveLength(2);
  });

  it("matches the issue number for issue-backed discussions", () => {
    const result = filterThreadItems(items, "#7");
    expect(result).toHaveLength(1);
    expect(result[0]?.runId).toBe("20261128T100000Z-aaaa");
    expect(filterThreadItems(items, "9")).toHaveLength(1);
  });
});

describe("moveThreadFocus", () => {
  it("moves within bounds and wraps around for keyboard navigation", () => {
    expect(moveThreadFocus(0, 1, 3)).toBe(1);
    expect(moveThreadFocus(2, 1, 3)).toBe(0);
    expect(moveThreadFocus(0, -1, 3)).toBe(2);
  });

  it("handles empty lists and degenerate counts", () => {
    expect(moveThreadFocus(0, 1, 0)).toBe(-1);
    expect(moveThreadFocus(0, 1, 1)).toBe(0);
  });
});
