import type { RunSummary } from "../server/run-store-api.js";

/**
 * ThreadSidebar 用の表示項目。実 RunStore の `RunSummary` だけを入力にし、
 * 画面に必要な派生値（タイトル・サブタイトル・状態ラベル）をここで確定する。
 */
export interface ThreadItem {
  runId: string;
  title: string;
  subtitle: string;
  status: string;
  statusLabel: string;
  command: string;
  issueNumber: number | null;
  repository: string;
  updatedAt: string;
}

/**
 * 一覧 API と同じ件数上限。取得側（DEFAULT_LIST_LIMIT=50）と揃え、
 * 補完した prompt 情報もこの件数を超えて要求しない。
 */
export const THREAD_SIDEBAR_LIMIT = 50;

const statusLabels: Record<string, string> = {
  created: "作成済み",
  planning: "計画中",
  planned: "計画済み",
  implementing: "実装中",
  verifying: "検証中",
  reviewing: "レビュー中",
  fixing: "修正中",
  publishing: "公開中",
  awaiting_human: "承認待ち",
  blocked: "停止",
  failed: "失敗",
  cancelled: "中止",
  interrupted: "中断",
  timed_out: "タイムアウト",
  completed: "完了",
};

export function threadStatusLabel(status: string): string {
  return statusLabels[status] ?? status;
}

/**
 * RunSummary の表示タイトル。永続化された prompt 情報（titles）があればそれを使い、
 * 無ければ内部識別子ではなく安定した種別ラベルへフォールバックする。
 */
export function threadTitle(run: RunSummary): string {
  const persisted = run.title;
  if (typeof persisted === "string" && persisted.trim().length > 0) {
    return persisted.trim();
  }
  if (run.command === "consult") {
    return "相談";
  }
  if (run.issueNumber !== null) {
    return `#${String(run.issueNumber)}`;
  }
  return run.command;
}

/**
 * 表示項目を構築する。updatedAt の新しい順に並べ、件数上限を維持する。
 */
export function buildThreadItems(runs: readonly RunSummary[]): ThreadItem[] {
  return [...runs]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, THREAD_SIDEBAR_LIMIT)
    .map((run) => {
      return {
        runId: run.runId,
        title: threadTitle(run),
        subtitle: `${run.repository} · ${run.command}`,
        status: run.status,
        statusLabel: threadStatusLabel(run.status),
        command: run.command,
        issueNumber: run.issueNumber,
        repository: run.repository,
        updatedAt: run.updatedAt,
      };
    });
}

/**
 * タイトル / Run 識別子 / リポジトリ名 / Issue 番号をまたいだ大小文字無視の検索。
 * 空クエリは全件を返す。
 */
export function filterThreadItems(items: readonly ThreadItem[], query: string): ThreadItem[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return [...items];
  }
  return items.filter((item) => {
    const haystacks = [
      item.title,
      item.runId,
      item.repository,
      item.issueNumber !== null ? `#${String(item.issueNumber)}` : "",
      item.issueNumber !== null ? String(item.issueNumber) : "",
    ];
    return haystacks.some((haystack) => haystack.toLowerCase().includes(normalized));
  });
}

/**
 * 矢印キーによるフォーカス移動。リスト端では折り返す。
 * 件数 0 のときは -1（フォーカス対象なし）を返す。
 */
export function moveThreadFocus(currentIndex: number, delta: number, count: number): number {
  if (count <= 0) {
    return -1;
  }
  const wrapped = (((currentIndex + delta) % count) + count) % count;
  return wrapped;
}
