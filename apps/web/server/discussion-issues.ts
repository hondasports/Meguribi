import { spawn } from "node:child_process";
import type http from "node:http";
import { redactDiagnosticText } from "@meguribi/adapters";

export interface DiscussionIssuesCommandInput {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface DiscussionIssuesCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type DiscussionIssuesCommandRunner = (
  input: DiscussionIssuesCommandInput,
) => Promise<DiscussionIssuesCommandResult>;

export interface DiscussionIssuesApiOptions {
  repositoryPath: string;
  ghExecutable?: string;
  timeoutMs?: number;
  limit?: number;
  runCommand?: DiscussionIssuesCommandRunner;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LIMIT = 20;
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_TITLE_CHARS = 500;
const GH_ISSUE_ARGS = [
  "issue",
  "list",
  "--state",
  "open",
  "--limit",
  String(DEFAULT_LIMIT),
  "--json",
  "number,title,url",
] as const;

function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(value)}\n`);
}

function appendLimited(text: string, chunk: Buffer): string {
  if (text.length >= MAX_OUTPUT_CHARS) return text;
  return text + chunk.toString("utf8").slice(0, MAX_OUTPUT_CHARS - text.length);
}

export async function runGhIssueListCommand(
  input: DiscussionIssuesCommandInput,
): Promise<DiscussionIssuesCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(terminateTimer);
      clearTimeout(killTimer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    const terminateTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    const killTimer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, input.timeoutMs + 250);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.on("error", (error) => {
      stderr = appendLimited(stderr, Buffer.from(error.message));
      finish(1);
    });
    child.on("close", (exitCode) => {
      finish(exitCode ?? 1);
    });
  });
}

function issueTarget(urlValue: string, number: number): string {
  const url = new URL(urlValue);
  if (url.protocol !== "https:") throw new Error("issue url must use https");
  const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(url.pathname);
  if (match === null) throw new Error("issue url does not match a GitHub issue path");
  const [, owner, repository, rawNumber] = match;
  if (Number(rawNumber) !== number) throw new Error("issue number and url do not match");
  for (const segment of [owner, repository]) {
    if (!/^[A-Za-z0-9_.-]+$/.test(segment ?? "") || (segment ?? "").includes("..")) {
      throw new Error("issue repository identity is invalid");
    }
  }
  return `${owner}/${repository}#${String(number)}`;
}

function parseIssues(stdout: string, limit: number): Array<{ target: string; title: string }> {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("gh issue list output must be an array");
  return parsed.slice(0, limit).map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("gh issue entry must be an object");
    }
    const record = value as { number?: unknown; title?: unknown; url?: unknown };
    if (!Number.isInteger(record.number) || (record.number as number) < 1) {
      throw new Error("gh issue number is invalid");
    }
    if (
      typeof record.title !== "string" ||
      record.title.trim().length === 0 ||
      record.title.length > MAX_TITLE_CHARS
    ) {
      throw new Error("gh issue title is invalid");
    }
    if (typeof record.url !== "string" || record.url.length > 1_000) {
      throw new Error("gh issue url is invalid");
    }
    return {
      target: issueTarget(record.url, record.number as number),
      title: redactDiagnosticText(record.title),
    };
  });
}

function failureBody(result: DiscussionIssuesCommandResult): { error: string } {
  const detail = redactDiagnosticText((result.stderr || result.stdout).trim()).slice(0, 300);
  const suffix = detail.length > 0 ? `: ${detail}` : "";
  return {
    error: result.timedOut
      ? `Issue一覧の取得がタイムアウトしました。手入力またはIssueなしの相談は利用できます${suffix}`
      : `Issue一覧を取得できませんでした。手入力またはIssueなしの相談は利用できます${suffix}`,
  };
}

export function createDiscussionIssuesApi(options: DiscussionIssuesApiOptions): {
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
} {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const executable = options.ghExecutable ?? "gh";
  const runCommand = options.runCommand ?? runGhIssueListCommand;

  return {
    async handle(req, res) {
      const pathName = (req.url ?? "").split("?", 1)[0];
      if (pathName !== "/api/discussion/issues") return false;
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      const args = GH_ISSUE_ARGS.map((value) =>
        value === String(DEFAULT_LIMIT) ? String(limit) : value,
      );
      const result = await runCommand({
        executable,
        args,
        cwd: options.repositoryPath,
        timeoutMs,
      });
      if (result.timedOut || result.exitCode !== 0) {
        writeJson(res, 502, failureBody(result));
        return true;
      }
      try {
        writeJson(res, 200, { issues: parseIssues(result.stdout, limit) });
      } catch {
        writeJson(res, 502, {
          error: "Issue一覧の形式を確認できませんでした。手入力またはIssueなしの相談は利用できます",
        });
      }
      return true;
    },
  };
}
