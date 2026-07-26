import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemRunStore } from "./filesystem-run-store.js";

const temps: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-run-store-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("FileSystemRunStore", () => {
  it("creates, loads, updates, and stores artifacts under issue path", async () => {
    const root = await tempRoot();
    const store = new FileSystemRunStore({
      rootDir: root,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
      randomId: () => "ab12cd",
    });

    const created = await store.create({
      repository: "owner/repo",
      issueNumber: 22,
      command: "run",
      maxFixAttempts: 2,
      identity: {
        repository: "owner/repo",
        issueNumber: 22,
        branch: "meguribi/issue-22",
        worktreePath: "/tmp/wt",
        baseRef: "origin/main",
        baseSha: "base",
        headSha: "head",
        remoteIdentity: "github.com/owner/repo",
      },
    });

    expect(created.runId).toBe("20260726T120000Z-ab12cd");
    const statePath = path.join(
      root,
      "runs",
      "owner",
      "repo",
      "issue-22",
      created.runId,
      "state.json",
    );
    await expect(fs.access(statePath)).resolves.toBeUndefined();

    const loaded = await store.load(created.runId);
    expect(loaded?.status).toBe("created");

    const updated = await store.update(created.runId, {
      status: "planning",
      currentStep: "planning",
    });
    expect(updated.status).toBe("planning");

    await store.saveArtifact(created.runId, "plan.json", { ok: true });
    const artifact = await store.readArtifact<{ ok: boolean }>(created.runId, "plan.json");
    expect(artifact).toEqual({ ok: true });

    const latest = await store.loadLatest("owner/repo", 22);
    expect(latest?.runId).toBe(created.runId);
  });

  it("acquires exclusive issue locks", async () => {
    const root = await tempRoot();
    const store = new FileSystemRunStore({ rootDir: root });
    const created = await store.create({
      repository: "owner/repo",
      issueNumber: 1,
      command: "run",
      maxFixAttempts: 1,
      identity: {
        repository: "owner/repo",
        issueNumber: 1,
        branch: "b",
        worktreePath: "/tmp/wt",
        baseRef: "origin/main",
        baseSha: "a",
        headSha: "b",
        remoteIdentity: "remote",
      },
    });

    await store.acquireLock({
      repository: "owner/repo",
      issueNumber: 1,
      runId: created.runId,
    });
    await expect(
      store.acquireLock({
        repository: "owner/repo",
        issueNumber: 1,
        runId: "other",
      }),
    ).rejects.toThrow(/lock/i);
    await store.releaseLock({ repository: "owner/repo", issueNumber: 1 });
    await expect(
      store.acquireLock({
        repository: "owner/repo",
        issueNumber: 1,
        runId: "other",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects repository path traversal outside rootDir", async () => {
    const root = await tempRoot();
    const store = new FileSystemRunStore({ rootDir: root });
    await expect(
      store.loadLatest("../evil/repo", 1),
    ).rejects.toThrow(/Invalid repository|owner segment|escapes/i);
    await expect(
      store.create({
        repository: "owner/../evil",
        issueNumber: 1,
        command: "run",
        maxFixAttempts: 1,
        identity: {
          repository: "owner/../evil",
          issueNumber: 1,
          branch: "b",
          worktreePath: "/tmp/wt",
          baseRef: "origin/main",
          baseSha: "a",
          headSha: "b",
          remoteIdentity: "remote",
        },
      }),
    ).rejects.toThrow(/Invalid repository|repo segment|escapes/i);
  });
});
