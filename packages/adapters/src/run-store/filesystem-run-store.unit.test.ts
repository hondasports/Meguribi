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



  it("creates, loads, and lists issue-less consultation runs without an issue-0 path", async () => {
    const root = await tempRoot();
    const store = new FileSystemRunStore({
      rootDir: root,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
      randomId: () => "c0nsul",
    });

    const created = await store.create({
      repository: "owner/repo",
      command: "consult",
      maxFixAttempts: 0,
      consultation: {
        worktreePath: "/tmp/repository",
        remoteIdentity: "github.com/owner/repo",
      },
    });

    expect(created).toMatchObject({
      command: "consult",
      issueNumber: null,
      branch: null,
      worktreePath: "/tmp/repository",
      baseRef: null,
      baseSha: null,
      headSha: null,
      remoteIdentity: "github.com/owner/repo",
    });
    const statePath = path.join(
      root,
      "runs",
      "owner",
      "repo",
      "consultations",
      created.runId,
      "state.json",
    );
    await expect(fs.access(statePath)).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "runs", "owner", "repo", "issue-0"))).rejects.toMatchObject({ code: "ENOENT" });

    const loaded = await store.load(created.runId);
    expect(loaded).toMatchObject({ runId: created.runId, command: "consult", issueNumber: null });
    await expect(store.listRecent()).resolves.toEqual([
      expect.objectContaining({ runId: created.runId, command: "consult" }),
    ]);
    await expect(store.loadLatest("owner/repo", 0)).resolves.toBeNull();
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

  it("saves and reads back artifacts in subdirectories like steps/verify.json", async () => {
    const root = await tempRoot();
    const store = new FileSystemRunStore({ rootDir: root });
    const created = await store.create({
      repository: "owner/repo",
      issueNumber: 22,
      command: "run",
      maxFixAttempts: 1,
      identity: {
        repository: "owner/repo",
        issueNumber: 22,
        branch: "b",
        worktreePath: "/tmp/wt",
        baseRef: "origin/main",
        baseSha: "a",
        headSha: "b",
        remoteIdentity: "remote",
      },
    });

    const record = {
      stepId: "verify",
      kind: "verify",
      status: "completed",
      visit: 1,
      startedAt: "2026-07-26T12:00:00.000Z",
    };
    await store.saveArtifact(created.runId, "steps/verify.json", record);
    const read = await store.readArtifact<typeof record>(created.runId, "steps/verify.json");
    expect(read).toEqual(record);
  });

  it("lists recent runs in updatedAt order and skips corrupted state files", async () => {
    const root = await tempRoot();
    const randomIds = ["aa01", "bb02", "cc03", "dd04"];
    let randomIndex = 0;
    const store = new FileSystemRunStore({
      rootDir: root,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
      randomId: () => randomIds[randomIndex++] ?? "ee05",
    });
    const identity = (issueNumber: number) => ({
      repository: "owner/repo",
      issueNumber,
      branch: `meguribi/issue-${String(issueNumber)}`,
      worktreePath: "/tmp/wt",
      baseRef: "origin/main",
      baseSha: "base",
      headSha: "head",
      remoteIdentity: "github.com/owner/repo",
    });
    const createRun = (issueNumber: number) =>
      store.create({
        repository: "owner/repo",
        issueNumber,
        command: "run",
        maxFixAttempts: 1,
        identity: identity(issueNumber),
      });

    const oldest = await createRun(31);
    const newest = await createRun(32);
    const middle = await createRun(33);
    const corrupted = await createRun(34);
    await store.update(oldest.runId, { updatedAt: "2026-07-26T12:00:01.000Z" });
    await store.update(newest.runId, { updatedAt: "2026-07-26T12:00:03.000Z" });
    await store.update(middle.runId, { updatedAt: "2026-07-26T12:00:02.000Z" });
    const corruptedDirectory = await store.runDirectory(corrupted.runId);
    if (corruptedDirectory === null) {
      throw new Error("corrupted fixture run directory was not created");
    }
    await fs.writeFile(path.join(corruptedDirectory, "state.json"), "not json\n", "utf8");

    const all = await store.listRecent();
    expect(all.map((state) => state.runId)).toEqual([newest.runId, middle.runId, oldest.runId]);

    const limited = await store.listRecent(2);
    expect(limited.map((state) => state.runId)).toEqual([newest.runId, middle.runId]);
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
