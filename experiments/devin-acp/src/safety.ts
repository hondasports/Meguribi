import path from "node:path";

export function resolveWithin(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(root, candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path is outside the worktree: ${candidate}`);
  }
  return resolvedCandidate;
}

export function assertSafeFilePath(root: string, candidate: string, allowedWritePaths: string[]): string {
  const resolved = resolveWithin(root, candidate);
  const relative = path.relative(path.resolve(root), resolved).split(path.sep).join("/");
  const segments = relative.split("/");
  const baseName = segments.at(-1) ?? "";
  if (segments.includes(".git") || baseName.startsWith(".env") || /(?:credential|secret|token|key|password)/i.test(baseName)) {
    throw new Error(`protected file path: ${relative}`);
  }
  if (!allowedWritePaths.includes(relative)) {
    throw new Error(`write path is not allowlisted: ${relative}`);
  }
  return resolved;
}

export function assertSafeReadPath(root: string, candidate: string): string {
  const resolved = resolveWithin(root, candidate);
  const relative = path.relative(path.resolve(root), resolved).split(path.sep).join("/");
  const segments = relative.split("/");
  const baseName = segments.at(-1) ?? "";
  if (segments.includes(".git") || baseName.startsWith(".env") || /(?:credential|secret|token|key|password)/i.test(baseName)) {
    throw new Error(`protected read path: ${relative}`);
  }
  return resolved;
}

export function isForbiddenTool(title: string, name: string | null | undefined): boolean {
  return /(?:terminal|shell|command|git|commit|push|network|curl|wget|secret|token|credential|password|api.?key)/i.test(`${title} ${name ?? ""}`);
}
