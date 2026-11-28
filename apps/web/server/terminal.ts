import { redactDiagnosticText } from "@meguribi/adapters";
import type { WorkflowEvent } from "@meguribi/core";
import {
  TERMINAL_MAX_ROWS,
  TERMINAL_ROW_TEXT_MAX_LENGTH,
  type TerminalRow,
} from "../src/terminal-contract.js";

/**
 * 相談端末のイベント投影。events.jsonl の WorkflowEvent を増分で取り込み、
 * 安全な bounded snapshot（TerminalRow[]）を維持する。
 *
 * 安全方針:
 * - ツール引数・summary・思考・raw JSON・malformed turn の生テキストは出さない
 * - message 本文は封筒 JSON のトップレベル "message" 文字列だけを構造スキャンで抽出する
 *   （ネストした "message" や前置きの引用 JSON は拾わない）
 * - 分割秘密値が流出しないよう、確定した境界までしか開示しない
 * - composition の生バッファにも上限を設け、超えたら途中出力を止めて確定 turn で復帰する
 */

/**
 * ANSI エスケープシーケンスと制御文字を正規表現なしで除去する。
 * lint の no-control-regex と相性が悪いうえ、状態機械の方が意図が明確になる。
 * \n（0x0A）だけは行構造のために残す。
 */
function stripUnsafeCharacters(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      // ESC に続く CSI（ESC [ ...final byte）と OSC（ESC ] ...BEL）を読み飛ばす。
      const next = text[index + 1];
      if (next === "[") {
        index += 2;
        while (index < text.length) {
          const inner = text.charCodeAt(index);
          index += 1;
          if (inner >= 0x40 && inner <= 0x7e) break;
        }
        continue;
      }
      if (next === "]") {
        index += 2;
        while (index < text.length && text.charCodeAt(index) !== 0x07) {
          index += 1;
        }
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    const isControl =
      code <= 0x09 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      out += text[index]!;
    }
    index += 1;
  }
  return out;
}


/** 1 ターンの封筒生テキストの蓄積上限。表示は 500 字に丸まるので十分に大きく取る。 */
export const COMPOSITION_RAW_MAX_LENGTH = 16_000;

/**
 * eventLog.append は chunk 単位で redact するため、delta 分割された秘密値は
 * "[REDACTED]ijkl" のように suffix だけ残った形で再構成されうる。
 * プレースホルダ直後の未区切りトークン末尾（ASCII 印字可能・非空白の連続）は
 * 秘密値の断片でありうるので伏せる。日本語などの非 ASCII はトークンに混ざらないので残す。
 */
function maskRedactedSuffixes(text: string): string {
  const placeholder = "[REDACTED]";
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith(placeholder, index)) {
      out += placeholder;
      index += placeholder.length;
      // 直後の ASCII トークン連続を読み飛ばす。
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code < 0x21 || code > 0x7e) break;
        index += 1;
      }
      continue;
    }
    out += text[index]!;
    index += 1;
  }
  return out;
}

function sanitizeText(text: string): string {
  return maskRedactedSuffixes(redactDiagnosticText(stripUnsafeCharacters(text)));
}

function capText(text: string): string {
  if (text.length <= TERMINAL_ROW_TEXT_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, TERMINAL_ROW_TEXT_MAX_LENGTH - 3)}...`;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * 文字列リテラルの内容をデコードしながら読む進行中スキャナ。
 * 入力は引用符の内側（開始引用符の次）から始める。
 */
function decodeStringContent(raw: string, start: number): { text: string; end: number; closed: boolean } {
  let out = "";
  let index = start;
  while (index < raw.length) {
    const ch = raw[index]!;
    if (ch === '"') {
      return { text: out, end: index, closed: true };
    }
    if (ch === "\\") {
      const esc = raw[index + 1];
      if (esc === undefined) return { text: out, end: index, closed: false };
      if (esc === "u") {
        const hex = raw.slice(index + 2, index + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { text: out, end: index, closed: false };
        }
        out += String.fromCharCode(parseInt(hex, 16));
        index += 6;
        continue;
      }
      const decoded = SIMPLE_ESCAPES[esc];
      if (decoded === undefined) return { text: out, end: index, closed: false };
      out += decoded;
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return { text: out, end: index, closed: false };
}

/**
 * 蓄積された delta 生テキストから、封筒 JSON のトップレベル "message" 文字列だけを抽出する。
 * 深度と文字列内外を追跡する構造スキャンで、ネストした "message" キーや
 * 前置きの引用 JSON（文字列の中の `{`）を拾わない。
 */
export function extractEnvelopeMessage(raw: string): { text: string; closed: boolean } {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStarted = false;
  let index = 0;
  while (index < raw.length) {
    const ch = raw[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (objectStarted && depth === 1) {
        // depth 1 の文字列トークンはキー候補。完了している必要があるため、
        // この時点で閉じているかを調べる。
        const token = decodeStringContent(raw, index + 1);
        if (!token.closed) {
          return { text: "", closed: false };
        }
        if (token.text === "message") {
          // 次の非空白が ':' で、その次の非空白が '"' なら値の開始。
          let cursor = token.end + 1;
          while (cursor < raw.length && /\s/.test(raw[cursor]!)) cursor += 1;
          if (raw[cursor] !== ":") {
            index = token.end + 1;
            continue;
          }
          cursor += 1;
          while (cursor < raw.length && /\s/.test(raw[cursor]!)) cursor += 1;
          if (raw[cursor] !== '"') {
            return { text: "", closed: false };
          }
          const value = decodeStringContent(raw, cursor + 1);
          return { text: value.text, closed: value.closed };
        }
        // 関係ないキーはスキップして構造走査を続ける。
        index = token.end + 1;
        continue;
      }
      inString = true;
      index += 1;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      if (ch === "{" && depth === 1) {
        objectStarted = true;
      }
      index += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    index += 1;
  }
  return { text: "", closed: false };
}

/**
 * 確定していない末尾の部分的な ASCII トークンを開示しない。
 * 日本語（かな・漢字・句読点）や空白は ASCII 秘密値の構成文字になりえないため、
 * それらが現れた時点で手前は確定とみなせる。
 */
export function revealAtBoundary(text: string, closed: boolean): string {
  if (closed) {
    return text;
  }
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    const isAsciiTokenChar = code >= 0x21 && code <= 0x7e;
    if (!isAsciiTokenChar) {
      break;
    }
    end -= 1;
  }
  return text.slice(0, end).trimEnd();
}

interface LiveComposition {
  raw: string;
  sessionId: string;
  closed: boolean;
  overflowed: boolean;
  at: string;
  label: string;
}

export interface TerminalProjector {
  ingest(event: WorkflowEvent): void;
  snapshot(): TerminalRow[];
}

/**
 * 接続ごとの増分 projector。drain のたびに全履歴を再解析せず、
 * 新着イベントだけを取り込んで snapshot を維持する。
 */
export function createTerminalProjector(): TerminalProjector {
  const rows = new Map<string, TerminalRow>();
  const compositions = new Map<string, LiveComposition>();
  let statusSeq = 0;

  function upsertLiveRow(profileId: string): void {
    const composition = compositions.get(profileId);
    const rowId = `live-${profileId}`;
    if (composition === undefined || composition.overflowed) {
      rows.delete(rowId);
      return;
    }
    const extracted = extractEnvelopeMessage(composition.raw);
    const visible =
      composition.closed || extracted.closed
        ? extracted.text
        : revealAtBoundary(extracted.text, false);
    const text = capText(sanitizeText(visible));
    if (text.length === 0 && !composition.closed) {
      rows.delete(rowId);
      return;
    }
    rows.set(rowId, {
      id: rowId,
      at: composition.at,
      profileId,
      label: composition.label,
      kind: "message",
      text,
      active: !composition.closed,
    });
  }

  function pushStatus(profileId: string, label: string, at: string, text: string): void {
    const id = `status-${String(statusSeq)}`;
    statusSeq += 1;
    rows.set(id, {
      id,
      at,
      profileId,
      label,
      kind: "status",
      text: capText(sanitizeText(text)),
      active: false,
    });
  }

  function trimRows(): void {
    while (rows.size > TERMINAL_MAX_ROWS) {
      const oldest = rows.keys().next();
      if (oldest.done) break;
      rows.delete(oldest.value);
    }
  }

  return {
    ingest(event) {
      if (event.type === "discussion.turn") {
        const { turn } = event;
        compositions.delete(turn.speaker);
        rows.delete(`live-${turn.speaker}`);
        if (turn.malformed) {
          // malformed の envelope.message は未解析の生テキスト。内容は絶対に出さない。
          pushStatus(turn.speaker, turn.speakerLabel, turn.at, "ターンを解析できませんでした");
          trimRows();
          return;
        }
        rows.set(`turn-${turn.turnId}`, {
          id: `turn-${turn.turnId}`,
          at: turn.at,
          profileId: turn.speaker,
          label: turn.speakerLabel,
          kind: "message",
          text: capText(sanitizeText(turn.envelope.message)),
          active: false,
        });
        trimRows();
        return;
      }

      if (event.type !== "agent.event") {
        return;
      }

      const { profileId, agentLabel, role, event: agentEvent } = event;

      switch (agentEvent.type) {
        case "message.delta": {
          if (role !== "discussant") {
            break;
          }
          let composition = compositions.get(profileId);
          // completed 後の次の delta は新しいターンの開始なので raw をリセットする。
          // session が変わった場合も別の composition としてやり直す。
          if (
            composition !== undefined &&
            (composition.closed || composition.sessionId !== agentEvent.sessionId)
          ) {
            compositions.delete(profileId);
            composition = undefined;
          }
          if (composition === undefined) {
            composition = {
              raw: "",
              sessionId: agentEvent.sessionId,
              closed: false,
              overflowed: false,
              at: agentEvent.at,
              label: agentLabel,
            };
            compositions.set(profileId, composition);
          }
          if (!composition.overflowed) {
            composition.raw += agentEvent.text;
            if (composition.raw.length > COMPOSITION_RAW_MAX_LENGTH) {
              // 上限超過: 途中出力を止め、確定 turn から復帰する。
              composition.overflowed = true;
              composition.raw = "";
            }
          }
          composition.at = agentEvent.at;
          composition.label = agentLabel;
          upsertLiveRow(profileId);
          trimRows();
          break;
        }
        case "turn.completed": {
          const composition = compositions.get(profileId);
          if (composition !== undefined && composition.sessionId === agentEvent.sessionId) {
            composition.closed = true;
            composition.at = agentEvent.at;
            upsertLiveRow(profileId);
          }
          break;
        }
        case "session.started": {
          pushStatus(profileId, agentLabel, agentEvent.at, "セッションを開始しました");
          trimRows();
          break;
        }
        case "session.failed": {
          // error.message は生の診断を含みうるため出さず、制御された code のみ使う。
          pushStatus(profileId, agentLabel, agentEvent.at, `エラー: ${agentEvent.error.code}`);
          trimRows();
          break;
        }
        case "approval.required": {
          // summary にはコマンドや引数が入りうるため出さない。
          pushStatus(profileId, agentLabel, agentEvent.at, "承認を待っています");
          trimRows();
          break;
        }
        case "tool.started": {
          const key = `${profileId}:${agentEvent.sessionId}:${agentEvent.toolCallId ?? agentEvent.tool}`;
          const rowId = `tool-${key}`;
          rows.set(rowId, {
            id: rowId,
            at: agentEvent.at,
            profileId,
            label: agentLabel,
            kind: "tool",
            text: capText(sanitizeText(`${agentEvent.tool} 実行中`)),
            active: true,
          });
          trimRows();
          break;
        }
        case "tool.completed": {
          // rowId は key から常に導出できるため、未完了 tool で unbounded になる map は持たない。
          const key = `${profileId}:${agentEvent.sessionId}:${agentEvent.toolCallId ?? agentEvent.tool}`;
          const rowId = `tool-${key}`;
          const failed =
            agentEvent.status !== undefined && agentEvent.status !== "completed"
              ? true
              : agentEvent.exitCode !== undefined && agentEvent.exitCode !== 0;
          rows.set(rowId, {
            id: rowId,
            at: agentEvent.at,
            profileId,
            label: agentLabel,
            kind: "tool",
            text: capText(sanitizeText(failed ? `${agentEvent.tool} 失敗` : `${agentEvent.tool} 完了`)),
            active: false,
          });
          trimRows();
          break;
        }
        case "file.changed": {
          pushStatus(profileId, agentLabel, agentEvent.at, `ファイル変更: ${agentEvent.path}`);
          trimRows();
          break;
        }
        case "unknown": {
          // rawType すら出さない。未知は投影しない。
          break;
        }
      }
    },
    snapshot() {
      return [...rows.values()];
    },
  };
}

/**
 * 全履歴からの一括導出。テストと初期ロード用。
 * SSE の増分経路では createTerminalProjector を使う。
 */
export function projectTerminalRows(events: readonly WorkflowEvent[]): TerminalRow[] {
  const projector = createTerminalProjector();
  for (const event of events) {
    projector.ingest(event);
  }
  return projector.snapshot();
}
