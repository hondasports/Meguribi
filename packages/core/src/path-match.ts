function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a small protected-path glob subset to a RegExp.
 *
 * Supported:
 * - exact path segments
 * - `*` (within one path segment)
 * - double-star slash prefix (any directory depth)
 * - trailing slash double-star (directory tree)
 */
function globToRegExp(pattern: string): RegExp {
  let source = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (pattern.startsWith("/**", i) && i + 3 === pattern.length) {
      source += "(?:/.*)?";
      i += 3;
      continue;
    }
    if (pattern[i] === "*") {
      source += "[^/]*";
      i += 1;
      continue;
    }
    source += escapeRegexLiteral(pattern[i]!);
    i += 1;
  }
  source += "$";
  return new RegExp(source);
}

/**
 * Returns true when `filePath` matches any protected-path glob pattern.
 * Patterns without `/` also match any path segment (e.g. `.env*` ↔ `config/.env.local`).
 */
export function matchesProtectedPath(
  filePath: string,
  patterns: readonly string[],
): boolean {
  const value = filePath.replaceAll("\\", "/");
  return patterns.some((pattern) => {
    const normalized = pattern.replaceAll("\\", "/");
    const re = globToRegExp(normalized);
    if (re.test(value)) {
      return true;
    }
    if (!normalized.includes("/")) {
      return value.split("/").some((part) => re.test(part));
    }
    return false;
  });
}
