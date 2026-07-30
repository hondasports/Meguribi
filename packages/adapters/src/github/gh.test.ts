import { describe, expect, it } from "vitest";
import { createGitHubAdapter, type GitHubCommandRunner } from "./gh.js";

class QueueRunner implements GitHubCommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly responses: Array<{ exitCode: number | null; stdout: string; stderr: string }>) {}

  async run(args: readonly string[]) {
    this.calls.push([...args]);
    const response = this.responses.shift();
    if (!response) throw new Error("response queue exhausted");
    return response;
  }
}

function issueJson(comments: Array<{ id: number; body: string }> = []) {
  return JSON.stringify({
    number: 22,
    title: "Add feature",
    body: "Implement the feature.",
    labels: [{ name: "agent:ready" }],
    comments: comments.map((comment) => ({ ...comment, author: { login: "owner" } })),
    updatedAt: "2026-07-28T00:00:00.000Z",
  });
}

describe("GitHub CLI adapter", () => {
  it("normalizes Issue and comment JSON into domain fields", async () => {
    const runner = new QueueRunner([{ exitCode: 0, stdout: issueJson([{ id: 7, body: "comment" }]), stderr: "" }]);
    const adapter = createGitHubAdapter({ runner });

    await expect(adapter.getIssue("owner/repo", 22)).resolves.toEqual({
      number: 22,
      title: "Add feature",
      body: "Implement the feature.",
      labels: ["agent:ready"],
      comments: [{ id: 7, author: "owner", body: "comment" }],
      updatedAt: "2026-07-28T00:00:00.000Z",
    });
    expect(runner.calls[0]).toContain("--json");
  });

  it("searches Issues with an updated window and label", async () => {
    const runner = new QueueRunner([{ exitCode: 0, stdout: JSON.stringify([JSON.parse(issueJson())]), stderr: "" }]);
    const adapter = createGitHubAdapter({ runner });

    await expect(adapter.listIssues({ repository: "owner/repo", updatedSince: "2026-07-01", label: "product:discovery", limit: 5 })).resolves.toHaveLength(1);
    expect(runner.calls[0]).toContain("updated:>=2026-07-01 label:product:discovery");
    expect(runner.calls[0]).toContain("5");
  });

  it("fails closed when duplicate Meguribi markers exist", async () => {
    const runner = new QueueRunner([
      {
        exitCode: 0,
        stdout: issueJson([
          { id: 7, body: "<!-- meguribi:delivery-summary -->\none" },
          { id: 8, body: "<!-- meguribi:delivery-summary -->\ntwo" },
        ]),
        stderr: "",
      },
    ]);
    const adapter = createGitHubAdapter({ runner });

    await expect(
      adapter.upsertMarkerComment({
        repository: "owner/repo",
        issueNumber: 22,
        marker: "<!-- meguribi:delivery-summary -->",
        body: "updated",
      }),
    ).rejects.toThrow(/Multiple Meguribi comments/);
  });

  it("creates a Draft PR and verifies GitHub kept it as Draft", async () => {
    const runner = new QueueRunner([
      { exitCode: 0, stdout: "https://github.com/owner/repo/pull/23\n", stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ number: 23, url: "https://github.com/owner/repo/pull/23", isDraft: true }), stderr: "" },
    ]);
    const adapter = createGitHubAdapter({ runner });

    await expect(
      adapter.createDraftPullRequest({
        repository: "owner/repo",
        title: "Add feature",
        body: "Closes #22",
        head: "meguribi/issue-22",
        base: "main",
      }),
    ).resolves.toEqual({ number: 23, url: "https://github.com/owner/repo/pull/23" });
    expect(runner.calls[0]).toContain("--draft");
  });

  it("normalizes Pull Request merge state and head identity", async () => {
    const runner = new QueueRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 23,
          url: "https://github.com/owner/repo/pull/23",
          state: "CLOSED",
          mergedAt: "2026-07-30T00:00:00Z",
          headRefName: "meguribi/issue-22",
          headRefOid: "head-sha",
        }),
        stderr: "",
      },
    ]);
    const adapter = createGitHubAdapter({ runner });

    await expect(adapter.getPullRequest("owner/repo", 23)).resolves.toEqual({
      number: 23,
      url: "https://github.com/owner/repo/pull/23",
      state: "closed",
      merged: true,
      head: "meguribi/issue-22",
      headSha: "head-sha",
    });
  });
});
