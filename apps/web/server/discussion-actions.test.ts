import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemDiscussionStore, FileSystemRunStore } from "@meguribi/adapters";
import type { DiscussionConclusion, RunState } from "@meguribi/core";
import { createDiscussionActions, type CliRunner } from "./discussion-actions.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-web-actions-"));
  tempDirs.push(rootDir);
  let randomIndex = 0;
  const runStore = new FileSystemRunStore({
    rootDir,
    now: () => new Date("2026-11-28T12:00:00.000Z"),
    randomId: () => `action${String(++randomIndex).padStart(2, "0")}`,
  });
  return { rootDir, runStore };
}

function conclusionFixture(): DiscussionConclusion {
  return {
    topic: "topic",
    conclusion: "A 案で進める",
    issues: [],
    rejectedOptions: [],
    openQuestions: [],
    acceptanceCriteriaSeeds: [],
    endedBy: "consensus",
    transcriptHash: "hash",
  };
}

async function createDiscussionRun(
  runStore: FileSystemRunStore,
  input: { status?: RunState["status"]; conclusion?: boolean } = {},
): Promise<RunState> {
  const state = await runStore.create({
    repository: "owner/repo",
    issueNumber: 83,
    command: "discuss",
    maxFixAttempts: 0,
    identity: {
      repository: "owner/repo",
      issueNumber: 83,
      branch: "meguribi/issue-83",
      worktreePath: "/tmp/worktree",
      baseRef: "origin/main",
      baseSha: "base",
      headSha: "head",
      remoteIdentity: "github.com/owner/repo",
    },
  });
  if (input.status !== undefined) {
    await runStore.update(state.runId, { status: input.status });
  }
  if (input.conclusion === true) {
    await new FileSystemDiscussionStore({ runStore, runId: state.runId }).saveConclusion(
      conclusionFixture(),
    );
  }
  return state;
}

function recordingCli(result: { exitCode: number; stdout: string; stderr: string }): {
  cli: CliRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    cli: {
      async run(args) {
        calls.push([...args]);
        return result;
      },
    },
  };
}

async function withActionServer(
  input: { runStore: FileSystemRunStore; cli: CliRunner },
  run: (port: number) => Promise<void>,
): Promise<void> {
  const actions = createDiscussionActions({ runStore: input.runStore, cli: input.cli });
  const server = http.createServer((req, res) => {
    actions
      .handle(req, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Not found" }));
        }
      })
      .catch((error: unknown) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("missing test port");
  try {
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function postJson(
  port: number,
  requestPath: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function localHeaders(port: number): Record<string, string> {
  return { Origin: `http://127.0.0.1:${String(port)}` };
}

describe("discussion actions", () => {
  it("passes a shell-like multiline message to say as one CLI argument without writing the store itself", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore);
    const { cli, calls } = recordingCli({ exitCode: 0, stdout: "written", stderr: "" });
    const message = "一行目\n; rm -rf ~\n$(touch /tmp/pwned)";

    await withActionServer({ runStore, cli }, async (port) => {
      const response = await postJson(
        port,
        `/api/run-store/runs/${run.runId}/say`,
        { message },
        localHeaders(port),
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, stdout: "written" });
      expect(calls).toEqual([["say", run.runId, message]]);
    });

    const runDir = await runStore.runDirectory(run.runId);
    expect(await fs.readdir(path.join(runDir!, "inbox")).catch(() => [])).toEqual([]);
  });

  it("rejects blank and overlong say messages before invoking the CLI", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore);
    const { cli, calls } = recordingCli({ exitCode: 0, stdout: "", stderr: "" });

    await withActionServer({ runStore, cli }, async (port) => {
      for (const message of ["   ", "x".repeat(4001)]) {
        const response = await postJson(
          port,
          `/api/run-store/runs/${run.runId}/say`,
          { message },
          localHeaders(port),
        );
        expect(response.status).toBe(400);
      }
      expect(calls).toEqual([]);
    });
  });

  it("returns 404 for a missing run and 409 when say is not interjectable", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore, { status: "awaiting_human" });
    const { cli, calls } = recordingCli({ exitCode: 0, stdout: "", stderr: "" });

    await withActionServer({ runStore, cli }, async (port) => {
      const missing = await postJson(
        port,
        "/api/run-store/runs/missing-run/say",
        { message: "hello" },
        localHeaders(port),
      );
      expect(missing.status).toBe(404);
      const closed = await postJson(
        port,
        `/api/run-store/runs/${run.runId}/say`,
        { message: "hello" },
        localHeaders(port),
      );
      expect(closed.status).toBe(409);
      expect(calls).toEqual([]);
    });
  });

  it("passes approve comments as CLI arguments and does not write approval.json itself", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore, { status: "awaiting_human", conclusion: true });
    const { cli, calls } = recordingCli({ exitCode: 0, stdout: "approved", stderr: "" });

    await withActionServer({ runStore, cli }, async (port) => {
      const response = await postJson(
        port,
        `/api/run-store/runs/${run.runId}/approve`,
        { comment: "この方向で進める" },
        localHeaders(port),
      );
      expect(response.status).toBe(200);
      expect(calls).toEqual([["approve", run.runId, "--comment", "この方向で進める"]]);
    });
    expect(await runStore.readArtifact(run.runId, "approval.json")).toBeNull();
  });

  it("returns 409 when approve has no conclusion and 422 with redacted stderr when the CLI fails", async () => {
    const { runStore } = await createFixture();
    const missingConclusion = await createDiscussionRun(runStore, { status: "awaiting_human" });
    const decided = await createDiscussionRun(runStore, {
      status: "awaiting_human",
      conclusion: true,
    });
    const { cli, calls } = recordingCli({
      exitCode: 1,
      stdout: "",
      stderr: "not_awaiting_approval token=abc123456789\nnext: meguribi status",
    });

    await withActionServer({ runStore, cli }, async (port) => {
      const conflict = await postJson(
        port,
        `/api/run-store/runs/${missingConclusion.runId}/approve`,
        {},
        localHeaders(port),
      );
      expect(conflict.status).toBe(409);
      const failed = await postJson(
        port,
        `/api/run-store/runs/${decided.runId}/approve`,
        {},
        localHeaders(port),
      );
      expect(failed.status).toBe(422);
      const body = failed.body as { ok: boolean; stderr: string };
      expect(body.ok).toBe(false);
      expect(body.stderr).toContain("not_awaiting_approval");
      expect(body.stderr).not.toContain("abc123456789");
      expect(calls).toEqual([["approve", decided.runId]]);
    });
  });

  it("passes reject reason and waits for a non-redo rejection", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore, { status: "awaiting_human", conclusion: true });
    const { cli, calls } = recordingCli({ exitCode: 0, stdout: "rejected", stderr: "" });
    const reason = "前提が違う\n; rm -rf ~";

    await withActionServer({ runStore, cli }, async (port) => {
      const response = await postJson(
        port,
        `/api/run-store/runs/${run.runId}/reject`,
        { reason, redo: false },
        localHeaders(port),
      );
      expect(response.status).toBe(200);
      expect(calls).toEqual([["reject", run.runId, "--reason", reason]]);
    });
  });

  it("validates reject input before invoking the CLI", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore, { status: "awaiting_human", conclusion: true });
    const { cli, calls } = recordingCli({ exitCode: 0, stdout: "", stderr: "" });

    await withActionServer({ runStore, cli }, async (port) => {
      for (const body of [
        { reason: " ", redo: false },
        { reason: "x".repeat(2001), redo: false },
        { reason: "valid" },
        { reason: "valid", redo: "yes" },
      ]) {
        const response = await postJson(
          port,
          `/api/run-store/runs/${run.runId}/reject`,
          body,
          localHeaders(port),
        );
        expect(response.status).toBe(400);
      }
      expect(calls).toEqual([]);
    });
  });

  it("starts reject --redo asynchronously with 202 and argument-array CLI invocation", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore, { status: "awaiting_human", conclusion: true });
    const calls: string[][] = [];
    const cli: CliRunner = {
      run(args) {
        calls.push([...args]);
        setTimeout(() => {
          void runStore.update(run.runId, { status: "created" });
        }, 10);
        return new Promise(() => {});
      },
    };

    await withActionServer({ runStore, cli }, async (port) => {
      const response = await postJson(
        port,
        `/api/run-store/runs/${run.runId}/reject`,
        { reason: "やり直して", redo: true },
        localHeaders(port),
      );
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ ok: true, started: true });
      expect(calls).toEqual([["reject", run.runId, "--reason", "やり直して", "--redo"]]);
    });
  });

  it("rejects cross-origin or non-loopback write requests before invoking the CLI", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore, { status: "awaiting_human", conclusion: true });
    const { cli, calls } = recordingCli({ exitCode: 0, stdout: "", stderr: "" });

    await withActionServer({ runStore, cli }, async (port) => {
      const forbiddenHeaders: Record<string, string>[] = [
        { Origin: "https://evil.example" },
        { Origin: "null" },
        { Host: "evil.example" },
      ];
      for (const headers of forbiddenHeaders) {
        const response = await postJson(
          port,
          `/api/run-store/runs/${run.runId}/approve`,
          {},
          headers,
        );
        expect(response.status).toBe(403);
      }
      expect(calls).toEqual([]);
    });
  });

  it("accepts same-origin localhost writes and rejects non-POST action methods", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore, { status: "awaiting_human", conclusion: true });
    const { cli, calls } = recordingCli({ exitCode: 0, stdout: "", stderr: "" });

    await withActionServer({ runStore, cli }, async (port) => {
      const response = await postJson(
        port,
        `/api/run-store/runs/${run.runId}/approve`,
        {},
        { Origin: `http://localhost:${String(port)}`, Host: `localhost:${String(port)}` },
      );
      expect(response.status).toBe(200);
      expect(calls).toEqual([["approve", run.runId]]);

      const getStatus = await new Promise<number>((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port, path: `/api/run-store/runs/${run.runId}/approve` },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
      });
      expect(getStatus).toBe(405);
    });
  });
});

describe("discussion redo start coordination", () => {
  it("blocks approval while redo start is unconfirmed and returns 202 only after the run leaves awaiting_human", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore, { status: "awaiting_human", conclusion: true });
    const calls: string[][] = [];
    const cli: CliRunner = {
      run(args) {
        calls.push([...args]);
        if (args[0] === "reject") {
          setTimeout(() => {
            void runStore.update(run.runId, { status: "created" });
          }, 30);
          return new Promise(() => {});
        }
        return Promise.resolve({ exitCode: 0, stdout: "approved", stderr: "" });
      },
    };

    await withActionServer({ runStore, cli }, async (port) => {
      const redoResponsePromise = postJson(
        port,
        `/api/run-store/runs/${run.runId}/reject`,
        { reason: "やり直して", redo: true },
        localHeaders(port),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      const approveDuringStart = await postJson(
        port,
        `/api/run-store/runs/${run.runId}/approve`,
        {},
        localHeaders(port),
      );
      const redoResponse = await redoResponsePromise;

      expect(approveDuringStart.status).toBe(409);
      expect(redoResponse.status).toBe(202);
      expect(redoResponse.body).toEqual({ ok: true, started: true });
      expect(calls).toEqual([["reject", run.runId, "--reason", "やり直して", "--redo"]]);
    });
  });
});

describe("discussion action race and content type protections", () => {
  it("surfaces the losing approve in a simultaneous double approval as 422", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore, { status: "awaiting_human", conclusion: true });
    const calls: string[][] = [];
    let count = 0;
    const cli: CliRunner = {
      async run(args) {
        calls.push([...args]);
        count += 1;
        if (count === 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await runStore.update(run.runId, { status: "completed" });
          return { exitCode: 0, stdout: "approved", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "not_awaiting_approval\nnext: meguribi status" };
      },
    };

    await withActionServer({ runStore, cli }, async (port) => {
      const [first, second] = await Promise.all([
        postJson(port, `/api/run-store/runs/${run.runId}/approve`, {}, localHeaders(port)),
        postJson(port, `/api/run-store/runs/${run.runId}/approve`, {}, localHeaders(port)),
      ]);
      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 422]);
      const loser = first.status === 422 ? first : second;
      expect((loser.body as { stderr: string }).stderr).toContain("not_awaiting_approval");
      expect(calls).toEqual([
        ["approve", run.runId],
        ["approve", run.runId],
      ]);
    });
  });

  it("rejects say for terminal states and reject/approve for non-discussion runs", async () => {
    const { runStore } = await createFixture();
    const completed = await createDiscussionRun(runStore, { status: "completed" });
    const failed = await createDiscussionRun(runStore, { status: "failed" });
    const plainRun = await runStore.create({
      repository: "owner/repo",
      issueNumber: 96,
      command: "run",
      maxFixAttempts: 0,
      identity: {
        repository: "owner/repo",
        issueNumber: 96,
        branch: "meguribi/issue-96",
        worktreePath: "/tmp/worktree",
        baseRef: "origin/main",
        baseSha: "base",
        headSha: "head",
        remoteIdentity: "github.com/owner/repo",
      },
    });
    const { cli, calls } = recordingCli({ exitCode: 0, stdout: "", stderr: "" });

    await withActionServer({ runStore, cli }, async (port) => {
      for (const target of [completed, failed]) {
        const response = await postJson(
          port,
          `/api/run-store/runs/${target.runId}/say`,
          { message: "まだ読める?" },
          localHeaders(port),
        );
        expect(response.status).toBe(409);
      }
      const response = await postJson(
        port,
        `/api/run-store/runs/${plainRun.runId}/approve`,
        {},
        localHeaders(port),
      );
      expect(response.status).toBe(409);
      expect(calls).toEqual([]);
    });
  });

  it("requires an application/json content type so cross-site simple requests cannot reach the CLI", async () => {
    const { runStore } = await createFixture();
    const run = await createDiscussionRun(runStore, { status: "awaiting_human", conclusion: true });
    const { cli, calls } = recordingCli({ exitCode: 0, stdout: "", stderr: "" });

    await withActionServer({ runStore, cli }, async (port) => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: `/api/run-store/runs/${run.runId}/approve`,
            method: "POST",
            headers: {
              "Content-Type": "text/plain",
              Origin: `http://127.0.0.1:${String(port)}`,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({}));
      });
      expect(status).toBe(415);
      expect(calls).toEqual([]);
    });
  });
});
