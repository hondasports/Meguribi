/**
 * Cursor CLI の version 文字列を解析する。
 * 汎用の Semver-like parser なので、Cursor / Devin 双方に利用可能。
 */

const SEMVER_LIKE =
  /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/;

export interface ParsedCursorVersion {
  raw: string;
  major?: number;
  minor?: number;
  patch?: number;
  parseable: boolean;
}

export function parseCursorVersionOutput(stdout: string): ParsedCursorVersion {
  const raw = stdout.trim();
  if (!raw) {
    return { raw: "", parseable: false };
  }
  const match = SEMVER_LIKE.exec(raw);
  if (!match) {
    return { raw, parseable: false };
  }
  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    parseable: true,
  };
}

export function compareSemver(
  left: { major: number; minor: number; patch: number },
  right: { major: number; minor: number; patch: number },
): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function parseMinimumVersion(
  minimum: string,
): { major: number; minor: number; patch: number } | undefined {
  const parsed = parseCursorVersionOutput(minimum);
  if (
    !parsed.parseable ||
    parsed.major === undefined ||
    parsed.minor === undefined ||
    parsed.patch === undefined
  ) {
    return undefined;
  }
  return { major: parsed.major, minor: parsed.minor, patch: parsed.patch };
}
