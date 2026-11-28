import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDiscussionIssuesApi,
  runGhIssueListCommand,
  type DiscussionIssuesCommandRunner,
} from "./discussion-issues.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function withServer(
  input: {
    runner?: DiscussionIssuesCommandRunner;
    ghExecutable?: string;
    timeoutMs?: number;
    repositoryPath?: string;
  },
  run: (port: number) => Promise<void>,
): Promise<void> {
  const api = createDiscussionIssuesApi({
    repositoryPath: input.repositoryPath ?? "/repo",
    ...(input.runner !== undefined ? { runCommand: input.runner } : {}),
    ...(input.ghExecutable !== undefined ? { ghExecutable: input.ghExecutable } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("missing test port");
  try {
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function get(port: number, pathName: string) {
  const response = await fetch(`http://127.0.0.1:${String(port)}${pathName}`);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

function issuesJson(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      number: index + 1,
      title: `Issue ${String(index + 1)}`,
      url: `https://github.com/owner/repo/issues/${String(index + 1)}`,
    })),
  );
}

describe("discussion issues API", () => {
  it("does not call GitHub until the lazy GET endpoint is used", async () => {
    const calls: unknown[] = [];
    await withServer(
      {
        runner: async (input) => {
          calls.push(input);
          return { exitCode: 0, stdout: "[]", stderr: "", timedOut: false };
        },
      },
      async () => {
        expect(calls).toEqual([]);
      },
    );
  });

  it("returns a small open issue list using fixed server-side gh argv", async () => {
    const calls: Array<{ executable: string; args: string[]; cwd: string; timeoutMs: number }> = [];
    await withServer(
      {
        runner: async (input) => {
          calls.push(input);
          return { exitCode: 0, stdout: issuesJson(2), stderr: "", timedOut: false };
        },
      },
      async (port) => {
        const response = await get(port, "/api/discussion/issues");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          issues: [
            { target: "owner/repo#1", title: "Issue 1" },
            { target: "owner/repo#2", title: "Issue 2" },
          ],
        });
      },
    );
    expect(calls).toEqual([
      {
        executable: "gh",
        args: ["issue", "list", "--state", "open", "--limit", "20", "--json", "number,title,url"],
        cwd: "/repo",
        timeoutMs: 5_000,
      },
    ]);
  });

  it("caps the returned issue count even if the CLI emits more", async () => {
    await withServer(
      {
        runner: async () => ({ exitCode: 0, stdout: issuesJson(25), stderr: "", timedOut: false }),
      },
      async (port) => {
        const response = await get(port, "/api/discussion/issues");
        expect(response.status).toBe(200);
        expect((response.body as { issues: unknown[] }).issues).toHaveLength(20);
      },
    );
  });

  it("returns a clear optional-list error without affecting other routes", async () => {
    await withServer(
      {
        runner: async () => ({ exitCode: 1, stdout: "", stderr: "auth failed", timedOut: false }),
      },
      async (port) => {
        const response = await get(port, "/api/discussion/issues");
        expect(response.status).toBe(502);
        expect(response.body.error).toContain("Issue");
        const missing = await get(port, "/other");
        expect(missing.status).toBe(404);
      },
    );
  });

  it("rejects malformed gh output instead of treating it as trusted instructions", async () => {
    await withServer(
      {
        runner: async () => ({ exitCode: 0, stdout: "not json", stderr: "", timedOut: false }),
      },
      async (port) => {
        const response = await get(port, "/api/discussion/issues");
        expect(response.status).toBe(502);
      },
    );
  });

  it("times out a hung gh CLI", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "meguribi-fake-gh-"));
    tempDirs.push(dir);
    const started = Date.now();
    const result = await runGhIssueListCommand({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => undefined, 10_000)"],
      cwd: dir,
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
