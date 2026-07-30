import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitHubAdapter, IssueRecord, PullRequestRecord } from "@meguribi/core";

export interface LocalGitHubAdapterOptions {
  cwd: string;
}

interface LocalIssueDocument {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments?: Array<{ id: number; author: string; body: string }>;
  updatedAt: string;
}

interface LocalComment {
  id: number;
  author: string;
  body: string;
}

interface LocalPullRequest {
  number: number;
  url: string;
  head: string;
  headSha: string;
  state: "open" | "closed";
  merged: boolean;
}

function issuePath(cwd: string, issueNumber: number): string {
  return path.join(cwd, ".meguribi", `issue-${String(issueNumber)}.json`);
}

function localStatePath(cwd: string, name: string): string {
  return path.join(cwd, ".meguribi-local", name);
}

async function readJson<T>(pathname: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(pathname, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(pathname: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateIssue(value: LocalIssueDocument, issueNumber: number): IssueRecord {
  if (
    value.number !== issueNumber ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    !Array.isArray(value.labels) ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error(`Invalid local Issue document for #${String(issueNumber)}; check .meguribi/issue-${String(issueNumber)}.json`);
  }
  return {
    number: value.number,
    title: value.title,
    body: value.body,
    labels: value.labels,
    comments: value.comments ?? [],
    updatedAt: value.updatedAt,
  };
}

export function createLocalGitHubAdapter(options: LocalGitHubAdapterOptions): GitHubAdapter {
  async function getIssue(repository: string, issueNumber: number): Promise<IssueRecord> {
    const document = await readJson<LocalIssueDocument>(issuePath(options.cwd, issueNumber));
    if (!document) {
      throw new Error(`Local Issue not found: ${repository}#${String(issueNumber)}; create .meguribi/issue-${String(issueNumber)}.json`);
    }
    const issue = validateIssue(document, issueNumber);
    const persistedComments = (await readJson<LocalComment[]>(localStatePath(options.cwd, `comments-${String(issueNumber)}.json`))) ?? [];
    return { ...issue, comments: [...issue.comments, ...persistedComments] };
  }

  return {
    getIssue,

    async listIssues(input) {
      const issueRoot = path.join(options.cwd, ".meguribi");
      let documents: LocalIssueDocument[] = [];
      const issueList = await readJson<LocalIssueDocument[]>(path.join(issueRoot, "issues.json"));
      if (Array.isArray(issueList)) {
        documents = issueList;
      } else {
        let names: string[] = [];
        try {
          names = await readdir(issueRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        for (const name of names.filter((candidate) => /^issue-\d+\.json$/.test(candidate))) {
          const document = await readJson<LocalIssueDocument>(path.join(issueRoot, name));
          if (document) documents.push(document);
        }
      }
      const since = Date.parse(`${input.updatedSince}T00:00:00Z`);
      return documents
        .map((document) => validateIssue(document, document.number))
        .filter((issue) => Number.isNaN(since) || Date.parse(issue.updatedAt) >= since)
        .filter((issue) => input.label === undefined || issue.labels.includes(input.label))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, input.limit);
    },

    async getPullRequest(_repository, pullRequestNumber) {
      const pullRequest = await readJson<LocalPullRequest>(localStatePath(options.cwd, `draft-pr-${String(pullRequestNumber)}.json`));
      if (
        !pullRequest ||
        pullRequest.number !== pullRequestNumber ||
        typeof pullRequest.url !== "string" ||
        typeof pullRequest.head !== "string" ||
        typeof pullRequest.headSha !== "string" ||
        (pullRequest.state !== "open" && pullRequest.state !== "closed") ||
        typeof pullRequest.merged !== "boolean"
      ) {
        throw new Error(`Invalid local Pull Request document for #${String(pullRequestNumber)}; update .meguribi-local/draft-pr-${String(pullRequestNumber)}.json`);
      }
      return pullRequest satisfies PullRequestRecord;
    },

    async upsertMarkerComment(input) {
      const issue = await getIssue(input.repository, input.issueNumber);
      const commentsPath = localStatePath(options.cwd, `comments-${String(input.issueNumber)}.json`);
      const comments = (await readJson<LocalComment[]>(commentsPath)) ?? [];
      const matches = issue.comments.filter((comment) => comment.body.includes(input.marker));
      if (matches.length > 1) {
        throw new Error(`Multiple local Meguribi comments found for ${input.repository}#${String(input.issueNumber)}; remove duplicates and retry`);
      }
      if (matches.length === 1) {
        const next = comments.map((comment) => comment.id === matches[0].id ? { ...comment, body: input.body } : comment);
        await writeJson(commentsPath, next);
        return { commentId: matches[0].id };
      }
      const commentId = comments.reduce((maximum, comment) => Math.max(maximum, comment.id), 0) + 1;
      await writeJson(commentsPath, [...comments, { id: commentId, author: "local", body: input.body }]);
      return { commentId };
    },

    async findDraftPullRequest(input) {
      const pullRequests = (await readJson<Array<{ number: number; url: string; head: string }>>(localStatePath(options.cwd, "draft-prs.json"))) ?? [];
      const match = pullRequests.find((pullRequest) => pullRequest.head === input.head);
      return match ? { number: match.number, url: match.url } : null;
    },

    async createDraftPullRequest(input) {
      const prsPath = localStatePath(options.cwd, "draft-prs.json");
      const pullRequests = (await readJson<Array<{ number: number; url: string; head: string }>>(prsPath)) ?? [];
      const number = pullRequests.reduce((maximum, pullRequest) => Math.max(maximum, pullRequest.number), 0) + 1;
      const url = `local://draft-pr/${String(number)}`;
      await writeJson(prsPath, [...pullRequests, { number, url, head: input.head }]);
      await writeJson(localStatePath(options.cwd, `draft-pr-${String(number)}.json`), input);
      return { number, url };
    },
  };
}
