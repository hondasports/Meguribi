/**
 * Devin CLI 診断出力から secret らしき文字列を除去する。
 */

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk|api)[_-][A-Za-z0-9]{8,}\b/gi,
  // prefix 付きキー（DEVIN_CLIENT_SECRET / MY_ACCESS_TOKEN 等）も対象にする
  /\b[A-Za-z0-9_]*?(?:authorization|cookie|credential|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|client[_-]?id)\b\s*[:=]\s*\S+/gi,
  /\bBearer\s+[A-Za-z0-9._\-+=/]+\b/gi,
  /https?:\/\/[^\s"'`]+/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

export function redactDiagnosticText(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

const ESC = String.fromCharCode(0x1b);
const ANSI_ESCAPE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

function stripControlChars(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // Keep TAB; drop other C0 controls and DEL. Whitespace is normalized later.
    if (code === 0x09 || (code >= 0x20 && code !== 0x7f)) {
      result += char;
    }
  }
  return result;
}

/**
 * 人間向け表示・version.raw 向けに制御文字を除き一行へ正規化する。
 */
export function sanitizeDiagnosticDisplayText(text: string, maxLength = 120): string {
  const normalized = stripControlChars(text.replace(ANSI_ESCAPE, ""))
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
