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

const SECRET_KEY_PATTERN =
  /(?:^|[_.-])(?:authorization|cookie|credential|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|client[_-]?id)$/i;

/**
 * Object key が secret 候補かどうか。構造化 env / JSON の redaction に使う。
 */
export function isSecretKey(key: string): boolean {
  const normalized = key.trim();
  if (normalized.length === 0) {
    return false;
  }
  if (SECRET_KEY_PATTERN.test(normalized)) {
    return true;
  }
  // ENV 風の大文字キー（API_TOKEN / MY_ACCESS_TOKEN）
  if (/^[A-Z][A-Z0-9_]*$/.test(normalized) && /(token|secret|password|credential|authorization|cookie|api[_-]?key)/i.test(normalized)) {
    return true;
  }
  return /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|client[_-]?id)/i.test(
    normalized,
  );
}

export function redactDiagnosticText(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/**
 * JSON 互換値を再帰的に redact する。
 * secret らしいキー配下の値は文字列化せず丸ごと [REDACTED] にする（fail-closed）。
 */
export function redactJsonValue(value: unknown, key?: string): unknown {
  if (key !== undefined && isSecretKey(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactDiagnosticText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      redactJsonValue(child, childKey),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
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
