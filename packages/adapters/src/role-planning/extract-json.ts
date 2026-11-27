/**
 * エージェント応答から最後の ```json フェンスの内容を取り出す。
 * フェンスがない、または JSON として壊れている場合は undefined。
 */
export function extractFinalJson(text: string): unknown | undefined {
  const pattern = /```json\s*\n([\s\S]*?)```/g;
  let last: string | undefined;
  for (const match of text.matchAll(pattern)) {
    last = match[1];
  }
  const source = last ?? text.trim();
  try {
    const value: unknown = JSON.parse(source);
    // フェンスがあるときは従来どおり中身をそのまま返す。
    // フェンスがないときのフォールバックはオブジェクトだけを採用する
    // （配列や文字列では計画・レビューの content になり得ないため）。
    if (last === undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}
