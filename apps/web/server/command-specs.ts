import path from "node:path";

export const commandIds = [
  "doctor",
  "init",
  "discover",
  "hypothesis",
  "promote",
  "explore",
  "require",
  "plan",
  "review",
  "run",
  "resume",
  "measure",
  "cleanup",
] as const;
export type CommandId = (typeof commandIds)[number];

export interface CommandRequest {
  command: CommandId;
  target?: string;
  options?: Record<string, unknown>;
}

function optionString(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionBoolean(options: Record<string, unknown>, name: string): boolean {
  return options[name] === true;
}

function optionNumber(options: Record<string, unknown>, name: string): number | undefined {
  const value = options[name];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function assertSafePath(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (resolved.includes("\0")) throw new Error(`${label} contains an invalid path`);
  return resolved;
}

export function buildCliArgs(request: CommandRequest): string[] {
  const options = request.options ?? {};
  const args = ["exec", "tsx", "apps/cli/src/index.ts", request.command];
  if (request.command !== "doctor") {
    if (!request.target?.trim()) throw new Error("target is required for this command");
    args.push(request.target.trim());
  }
  const repoPath = optionString(options, "repoPath");
  if (request.command === "doctor") {
    const implementer = optionString(options, "implementer");
    if (implementer) args.push("--implementer", implementer);
    args.push("--json");
    return args;
  }
  if (request.command === "init") {
    if (repoPath) args[args.length - 1] = assertSafePath(repoPath, "repoPath");
    const implementer = optionString(options, "implementer");
    if (implementer) args.push("--implementer", implementer);
    args.push("--json");
    return args;
  }
  if (optionBoolean(options, "local")) args.push("--local");
  if (repoPath) args.push("--repo-path", assertSafePath(repoPath, "repoPath"));
  const implementer = optionString(options, "implementer");
  if (["run", "resume"].includes(request.command) && implementer)
    args.push("--implementer", implementer);
  const solution = optionNumber(options, "solution");
  if (request.command === "require" && solution) args.push("--solution", String(solution));
  const period = optionString(options, "period");
  if (request.command === "measure" && period) args.push("--period", period);
  if (request.command === "run") {
    const branch = optionString(options, "branch");
    const worktreePath = optionString(options, "worktreePath");
    if (branch) args.push("--branch", branch);
    if (worktreePath) args.push("--worktree-path", assertSafePath(worktreePath, "worktreePath"));
    if (optionBoolean(options, "nonInteractive")) args.push("--non-interactive");
    if (optionBoolean(options, "allowInheritedMcp")) args.push("--allow-inherited-mcp");
    if (optionBoolean(options, "noPush")) args.push("--no-push");
    if (optionBoolean(options, "noPr")) args.push("--no-pr");
  }
  args.push("--json");
  return args;
}

export function redactOutput(text: string): string {
  return text.replace(
    /((?:token|secret|password|api[-_]?key)\s*[:=]\s*)([^\s,;]+)/gi,
    "$1[REDACTED]",
  );
}
