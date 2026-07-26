const SECRET_PATTERNS: RegExp[] = [
  /\b(?:cog|sk|gh[pousr])_[A-Za-z0-9_-]+\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\b(api[_-]?key|token|password|secret|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi
];

export function redactText(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, (_match, name?: string) => {
    if (name) {
      return `${name}=<REDACTED>`;
    }
    return "<REDACTED>";
  }), value);
}
