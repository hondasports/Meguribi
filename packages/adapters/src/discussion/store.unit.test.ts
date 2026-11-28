import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiscussionConclusion, DiscussionTurn } from "@meguribi/core";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemRunStore } from "../run-store/index.js";
import { FileSystemDiscussionStore } from "./store.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<{
  root: string;
  runStore: FileSystemRunStore;
  runId: string;
  runDir: string;
  store: FileSystemDiscussionStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-discussion-store-"));
  tempRoots.push(root);
  const fixedNow = new Date("2026-11-28T10:00:00.000Z");
  const runStore = new FileSystemRunStore({
    rootDir: root,
    now: () => fixedNow,
    randomId: () => "ab12cd",
  });
  const state = await runStore.create({
    repository: "owner/repo",
    issueNumber: 83,
    command: "discuss",
    maxFixAttempts: 0,
    identity: {
      repository: "owner/repo",
      issueNumber: 83,
      branch: "feat/83-discussion-adapters",
      worktreePath: "/tmp/worktree",
      baseRef: "origin/main",
      baseSha: "base",
      headSha: "head",
      remoteIdentity: "github.com/owner/repo",
    },
  });
  const runDir = await runStore.runDirectory(state.runId);
  if (runDir === null) {
    throw new Error("run directory was not created");
  }
  const store = new FileSystemDiscussionStore({
    runStore,
    runId: state.runId,
    now: () => fixedNow,
  });
  return { root, runStore, runId: state.runId, runDir, store };
}

function turn(overrides: Partial<DiscussionTurn> = {}): DiscussionTurn {
  return {
    turnId: "t-1",
    speaker: "claude",
    speakerLabel: "Claude Code",
    envelope: {
      message: "通知は朝にまとめます",
      replyTo: [],
      addressTo: [],
      positions: [],
      newIssues: [],
      done: false,
    },
    malformed: false,
    at: "2026-11-28T10:00:00.000Z",
    ...overrides,
  };
}

function conclusion(overrides: Partial<DiscussionConclusion> = {}): DiscussionConclusion {
  return {
    topic: "通知タイミング",
    conclusion: "夜間通知は朝にまとめる",
    issues: [],
    rejectedOptions: [],
    openQuestions: [],
    acceptanceCriteriaSeeds: [],
    endedBy: "consensus",
    transcriptHash: "abc123",
    ...overrides,
  };
}

describe("FileSystemDiscussionStore", () => {
  it("appends turns to transcript.jsonl and reads them back in order", async () => {
    const { store } = await createFixture();

    await store.appendTurn(turn());
    await store.appendTurn(
      turn({
        turnId: "t-2",
        speaker: "codex",
        speakerLabel: "Codex",
        envelope: {
          message: "実装コストは低いです",
          replyTo: ["t-1"],
          addressTo: [],
          positions: [],
          newIssues: [],
          done: true,
        },
      }),
    );

    const turns = await store.readTurns();
    expect(turns.map((item) => item.turnId)).toEqual(["t-1", "t-2"]);
    expect(turns[1]?.envelope.replyTo).toEqual(["t-1"]);
  });

  it("rejects a transcript line that is valid JSON but not a DiscussionTurn", async () => {
    const { store, runDir } = await createFixture();
    const discussionDir = path.join(runDir, "discussion");
    await fs.mkdir(discussionDir, { recursive: true });
    await fs.writeFile(path.join(discussionDir, "transcript.jsonl"), `${JSON.stringify({ turnId: "t-1" })}\n`);

    await expect(store.readTurns()).rejects.toThrow(/Invalid discussion transcript/);
  });

  it("redacts secrets before saving transcript turns", async () => {
    const { store, runDir } = await createFixture();
    const secret = "token=supersecretvalue123";
    await store.appendTurn(
      turn({
        envelope: {
          message: `秘密は ${secret} です`,
          replyTo: [],
          addressTo: [],
          positions: [],
          newIssues: [],
          done: false,
        },
      }),
    );

    const raw = await fs.readFile(path.join(runDir, "discussion", "transcript.jsonl"), "utf8");
    expect(raw).not.toContain("supersecretvalue123");
    const turns = await store.readTurns();
    expect(turns[0]?.envelope.message).not.toContain("supersecretvalue123");
    expect(turns[0]?.envelope.message).toContain("[REDACTED]");
  });

  it("writes and reads human messages through inbox, moving consumed files to processed", async () => {
    const { store, runDir } = await createFixture();

    const writtenPath = await store.writeHumanMessage("人間の補足です");
    expect(path.dirname(writtenPath)).toBe(path.join(runDir, "inbox"));
    expect(path.basename(writtenPath)).toMatch(/\.json$/);

    const messages = await store.readHumanMessages();
    expect(messages).toEqual([
      { message: "人間の補足です", at: "2026-11-28T10:00:00.000Z" },
    ]);

    const processedEntries = await fs.readdir(path.join(runDir, "inbox", "processed"));
    expect(processedEntries).toContain(path.basename(writtenPath));
    await expect(store.readHumanMessages()).resolves.toEqual([]);
  });

  it("reads inbox files in name order and moves broken files to processed without importing them", async () => {
    const { store, runDir } = await createFixture();
    const inboxDir = path.join(runDir, "inbox");
    await fs.mkdir(inboxDir, { recursive: true });
    await fs.writeFile(
      path.join(inboxDir, "2026-11-28T10-00-02-valid.json"),
      JSON.stringify({ message: "second", at: "2026-11-28T10:00:02.000Z" }),
    );
    await fs.writeFile(
      path.join(inboxDir, "2026-11-28T10-00-01-valid.json"),
      JSON.stringify({ message: "first", at: "2026-11-28T10:00:01.000Z" }),
    );
    await fs.writeFile(path.join(inboxDir, "broken.json"), "{not json");

    const messages = await store.readHumanMessages();

    expect(messages).toEqual([
      { message: "first", at: "2026-11-28T10:00:01.000Z" },
      { message: "second", at: "2026-11-28T10:00:02.000Z" },
    ]);
    const processedEntries = await fs.readdir(path.join(inboxDir, "processed"));
    expect(processedEntries.sort()).toEqual([
      "2026-11-28T10-00-01-valid.json",
      "2026-11-28T10-00-02-valid.json",
      "broken.json",
    ]);
  });

  it("truncates human messages to 4000 characters including the ellipsis", async () => {
    const { store } = await createFixture();
    const longMessage = "あ".repeat(4001);

    await store.writeHumanMessage(longMessage);
    const messages = await store.readHumanMessages();

    expect(messages[0]?.message).toHaveLength(4000);
    expect(messages[0]?.message.endsWith("…")).toBe(true);
  });

  it("saves and reads conclusion.json, returning null when absent", async () => {
    const { store } = await createFixture();

    await expect(store.readConclusion()).resolves.toBeNull();
    const value = conclusion();
    await store.saveConclusion(value);

    await expect(store.readConclusion()).resolves.toEqual(value);
  });
});
