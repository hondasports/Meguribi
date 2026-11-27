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
  if (last === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}
