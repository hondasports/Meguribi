import { ProcessError, ProcessRunner } from "@meguribi/process";
import type { GitHubAdapter, IssueRecord, PullRequestRecord } from "@meguribi/core";
import { redactDiagnosticText } from "../devin/redact.js";

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface GitHubCommandRunner {
  run(args: readonly string[]): Promise<CommandResult>;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

class ProcessGitHubCommandRunner implements GitHubCommandRunner {
  constructor(
    private readonly executable: string,
    private readonly cwd: string,
  ) {}

  async run(args: readonly string[]): Promise<CommandResult> {
    const child = new ProcessRunner().run(this.executable, [...args], {
      cwd: this.cwd,
      env: process.env,
      terminationGraceMs: 5_000,
    });
    const [stdout, stderr, exit] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      child.waitForExit(),
    ]);
    return { exitCode: exit.code, stdout, stderr };
  }
}

export interface GitHubAdapterOptions {
  executable?: string;
  cwd?: string;
  runner?: GitHubCommandRunner;
}

function parseJson<T>(text: string, action: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`GitHub returned invalid JSON while ${action}; retry the command and inspect gh auth status`);
  }
}

function commandError(repository: string, action: string, result: CommandResult): Error {
  const diagnostic = redactDiagnosticText(result.stderr.trim() || result.stdout.trim()).slice(0, 500);
  const lower = diagnostic.toLowerCase();
  if (lower.includes("not logged") || lower.includes("authentication") || lower.includes("login")) {
    return new Error(`GitHub authentication failed for ${repository} while ${action}; run gh auth status`);
  }
  if (lower.includes("permission") || lower.includes("forbidden")) {
    return new Error(`GitHub permission denied for ${repository} while ${action}; check repository permissions`);
  }
  if (lower.includes("not found") || lower.includes("could not resolve")) {
    return new Error(`GitHub target not found for ${repository} while ${action}; verify the repository and Issue/PR`);
  }
  return new Error(`GitHub command failed for ${repository} while ${action}: ${diagnostic || "unknown gh error"}`);
}

async function runGh(
  runner: GitHubCommandRunner,
  repository: string,
  action: string,
  args: readonly string[],
): Promise<string> {
  let result: CommandResult;
  try {
    result = await runner.run(args);
  } catch (error) {
    if (error instanceof ProcessError) {
      throw new Error(`Unable to run gh for ${repository} while ${action}: ${error.message}`);
    }
    throw error;
  }
  if (result.exitCode !== 0 || result.exitCode === null) {
    throw commandError(repository, action, result);
  }
  return result.stdout;
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  comments: Array<{ id: number; author?: { login?: string } | null; body: string }>;
  updatedAt: string;
}

interface GhPullRequest {
  number: number;
  url: string;
  isDraft?: boolean;
  state?: string;
  mergedAt?: string | null;
  headRefName?: string;
  headRefOid?: string;
}

function normalizeIssue(value: GhIssue): IssueRecord {
  if (!Number.isInteger(value.number) || typeof value.title !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("GitHub Issue response is missing required fields; retry after checking gh version");
  }
  return {
    number: value.number,
    title: value.title,
    body: value.body ?? "",
    labels: value.labels.map((label) => label.name).filter((name) => typeof name === "string"),
    comments: value.comments.map((comment) => ({
      id: comment.id,
      author: comment.author?.login ?? "unknown",
      body: comment.body,
    })),
    updatedAt: value.updatedAt,
  };
}

function normalizePullRequest(value: GhPullRequest): PullRequestRecord {
  if (
    !Number.isInteger(value.number) ||
    typeof value.url !== "string" ||
    (value.state !== "OPEN" && value.state !== "CLOSED") ||
    typeof value.headRefName !== "string" ||
    typeof value.headRefOid !== "string"
  ) {
    throw new Error("GitHub Pull Request response is missing required fields; retry after checking gh version");
  }
  return {
    number: value.number,
    url: value.url,
    state: value.state === "OPEN" ? "open" : "closed",
    merged: typeof value.mergedAt === "string" && value.mergedAt.length > 0,
    head: value.headRefName,
    headSha: value.headRefOid,
  };
}

export function createGitHubAdapter(options: GitHubAdapterOptions = {}): GitHubAdapter {
  const runner = options.runner ?? new ProcessGitHubCommandRunner(options.executable ?? "gh", options.cwd ?? process.cwd());

  async function getIssue(repository: string, issueNumber: number): Promise<IssueRecord> {
    const output = await runGh(runner, repository, `reading Issue #${String(issueNumber)}`, [
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repository,
      "--json",
      "number,title,body,labels,comments,updatedAt",
    ]);
    return normalizeIssue(parseJson<GhIssue>(output, `reading Issue #${String(issueNumber)}`));
  }

  return {
    async getIssue(repository, issueNumber) {
      return getIssue(repository, issueNumber);
    },

    async listIssues(input) {
      const search = [`updated:>=${input.updatedSince}`, ...(input.label ? [`label:${input.label}`] : [])].join(" ");
      const output = await runGh(runner, input.repository, "searching Issues for discovery", [
        "issue",
        "list",
        "--repo",
        input.repository,
        "--state",
        "all",
        "--limit",
        String(input.limit),
        "--search",
        search,
        "--json",
        "number,title,body,labels,comments,updatedAt",
      ]);
      const issues = parseJson<GhIssue[]>(output, "searching Issues for discovery");
      if (!Array.isArray(issues)) throw new Error("GitHub returned an invalid Issue list for discovery");
      return issues.map(normalizeIssue);
    },

    async getPullRequest(repository, pullRequestNumber) {
      const output = await runGh(runner, repository, `reading Pull Request #${String(pullRequestNumber)}`, [
        "pr",
        "view",
        String(pullRequestNumber),
        "--repo",
        repository,
        "--json",
        "number,url,state,mergedAt,headRefName,headRefOid",
      ]);
      return normalizePullRequest(parseJson<GhPullRequest>(output, `reading Pull Request #${String(pullRequestNumber)}`));
    },

    async upsertMarkerComment(input) {
      const issue = await getIssue(input.repository, input.issueNumber);
      const matches = issue.comments.filter((comment) => comment.body.includes(input.marker));
      if (matches.length > 1) {
        throw new Error(`Multiple Meguribi comments found on ${input.repository}#${String(input.issueNumber)}; remove duplicates and retry`);
      }
      if (matches.length === 1) {
        await runGh(runner, input.repository, "updating the Meguribi Issue comment", [
          "api",
          `repos/${input.repository}/issues/comments/${String(matches[0].id)}`,
          "--method",
          "PATCH",
          "--field",
          `body=${input.body}`,
        ]);
        return { commentId: matches[0].id };
      }
      const output = await runGh(runner, input.repository, "creating the Meguribi Issue comment", [
        "api",
        `repos/${input.repository}/issues/${String(input.issueNumber)}/comments`,
        "--method",
        "POST",
        "--field",
        `body=${input.body}`,
        "--jq",
        ".id",
      ]);
      const commentId = Number(output.trim());
      if (!Number.isSafeInteger(commentId) || commentId <= 0) {
        throw new Error(`GitHub did not return a valid comment id for ${input.repository}#${String(input.issueNumber)}`);
      }
      return { commentId };
    },

    async findDraftPullRequest(input) {
      const output = await runGh(runner, input.repository, "searching for an existing Draft PR", [
        "pr",
        "list",
        "--repo",
        input.repository,
        "--head",
        input.head,
        "--state",
        "open",
        "--json",
        "number,url,isDraft",
      ]);
      const pullRequests = parseJson<GhPullRequest[]>(output, "searching for an existing Draft PR");
      const draft = pullRequests.find((pullRequest) => pullRequest.isDraft);
      return draft ? { number: draft.number, url: draft.url } : null;
    },

    async createDraftPullRequest(input) {
      const output = await runGh(runner, input.repository, "creating a Draft PR", [
        "pr",
        "create",
        "--repo",
        input.repository,
        "--draft",
        "--head",
        input.head,
        "--base",
        input.base,
        "--title",
        input.title,
        "--body",
        input.body,
      ]);
      const url = output.trim().split(/\s+/).find((part) => part.startsWith("https://github.com/"));
      if (!url) {
        throw new Error(`GitHub did not return the created Draft PR URL for ${input.repository}; inspect gh output and retry`);
      }
      const viewOutput = await runGh(runner, input.repository, "reading the created Draft PR", [
        "pr",
        "view",
        url,
        "--repo",
        input.repository,
        "--json",
        "number,url,isDraft",
      ]);
      const pullRequest = parseJson<GhPullRequest>(viewOutput, "reading the created Draft PR");
      if (!pullRequest.isDraft) {
        throw new Error(`GitHub created a non-Draft PR for ${input.repository}; stopping before human review`);
      }
      return { number: pullRequest.number, url: pullRequest.url };
    },
  };
}
