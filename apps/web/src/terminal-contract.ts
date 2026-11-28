/**
 * 相談端末（live terminal）の全員共通契約。
 * server（A）が投影し、client（B/C）が描画する bounded snapshot の型。
 *
 * 安全方針:
 * - text はサーバー側で redact 済み・制御文字除去済み・文字数制限済み。
 * - ツール引数・思考・raw JSON・malformed turn の生テキストは行に含まれない。
 */

export type TerminalRowKind = "message" | "tool" | "status";

export interface TerminalRow {
  /** Run 内で安定した行識別子。再接続時の重複防止に使う。 */
  id: string;
  /** ISO 8601 タイムスタンプ。 */
  at: string;
  /** 発言/活動したエージェントの profile id。 */
  profileId: string;
  /** 表示用のエージェント名。 */
  label: string;
  /** 行の種別。message=発言本文、tool=ツール状態、status=進行状態。 */
  kind: TerminalRowKind;
  /** redaction・制御文字除去・文字数制限済みの本文。 */
  text: string;
  /** 進行中（delta 蓄積中・ツール実行中等）なら true。 */
  active: boolean;
}

/** SSE イベント `terminal` の data。全行を含む bounded snapshot で置き換え配信する。 */
export interface TerminalSnapshot {
  rows: TerminalRow[];
}

/** SSE のイベント名。 */
export const TERMINAL_SSE_EVENT = "terminal";

/** サーバー側の行数・文字数上限（共有の契約値）。 */
export const TERMINAL_MAX_ROWS = 200;
export const TERMINAL_ROW_TEXT_MAX_LENGTH = 500;
