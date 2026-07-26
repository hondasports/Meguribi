/**
 * Devin CLI 診断出力から secret らしき文字列を除去する。
 */

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk|api)[_-][A-Za-z0-9]{8,}\b/gi,
  /\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,
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
