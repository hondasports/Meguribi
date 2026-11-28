/**
 * 役割エージェント向けの再要求プロンプト。
 * codex/prompt.ts の buildRepairPrompt は Codex SDK 経路（フェンス不要）用なので、
 * フェンス抽出を行う役割セッションではこちらを使う。
 */
export function buildRoleRepairPrompt(
  role: "planner" | "reviewer" | "summarizer",
  validationError: string,
  keys: readonly string[],
): string {
  return [
    `The previous ${role} response was invalid.`,
    `Reason: ${validationError}`,
    "Output exactly one corrected JSON object inside a single ```json fence.",
    `The object must have only these keys: ${keys.join(", ")}.`,
    "Do not include explanations or any text after the closing fence.",
  ].join("\n");
}
