import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalGitHubAdapter } from "./local.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local Issue adapter", () => {
  it("reads an Issue document and persists an idempotent marker comment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meguribi-local-issue-"));
    roots.push(root);
    await mkdir(path.join(root, ".meguribi"), { recursive: true });
    await writeFile(
      path.join(root, ".meguribi", "issue-1.json"),
      JSON.stringify({
        number: 1,
        title: "Build TODO app",
        body: "Implement the app.",
        labels: ["agent:ready"],
        comments: [],
        updatedAt: "2026-07-28T00:00:00.000Z",
      }),
    );

    const adapter = createLocalGitHubAdapter({ cwd: root });
    await expect(adapter.getIssue("local/todo", 1)).resolves.toMatchObject({ title: "Build TODO app" });
    const first = await adapter.upsertMarkerComment({ repository: "local/todo", issueNumber: 1, marker: "<!-- marker -->", body: "<!-- marker -->\nfirst" });
    const second = await adapter.upsertMarkerComment({ repository: "local/todo", issueNumber: 1, marker: "<!-- marker -->", body: "<!-- marker -->\nsecond" });
    expect(second).toEqual(first);
    await expect(adapter.getIssue("local/todo", 1)).resolves.toMatchObject({ comments: [{ body: "<!-- marker -->\nsecond" }] });
  });

  it("lists local Issues by date and label for discovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meguribi-local-discovery-"));
    roots.push(root);
    await mkdir(path.join(root, ".meguribi"), { recursive: true });
    await writeFile(
      path.join(root, ".meguribi", "issues.json"),
      JSON.stringify([
        { number: 1, title: "Recent", body: "body", labels: ["product:discovery"], updatedAt: "2026-07-02T00:00:00.000Z" },
        { number: 2, title: "Old", body: "body", labels: ["product:discovery"], updatedAt: "2026-06-01T00:00:00.000Z" },
      ]),
    );

    const adapter = createLocalGitHubAdapter({ cwd: root });
    await expect(adapter.listIssues({ repository: "local/todo", updatedSince: "2026-07-01", label: "product:discovery", limit: 5 })).resolves.toMatchObject([{ number: 1 }]);
  });
});
