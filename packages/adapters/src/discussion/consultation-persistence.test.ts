import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPersistentConsultation, type DiscussionConclusion, type RoleAgent } from "@meguribi/core";
import { FileSystemRunStore } from "../run-store/filesystem-run-store.js";
import { FileSystemDiscussionStore } from "./store.js";

const temps: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-consultation-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function envelopeText(): string {
  return JSON.stringify({
    message: "consultation answer",
    replyTo: [],
    addressTo: [],
    positions: [],
    newIssues: [],
    done: true,
  });
}

function fakeAgent(id: string): RoleAgent {
  return {
    profileId: id,
    kind: "claude-code",
    async openSession() {
      return {
        sessionId: `session-${id}`,
        async send() {
          return { sessionId: `session-${id}`, text: envelopeText(), events: [] };
        },
        async close() {},
      };
    },
  } as unknown as RoleAgent;
}

function conclusion(topic: string): DiscussionConclusion {
  return {
    topic,
    conclusion: "consulted",
    issues: [],
    rejectedOptions: [],
    openQuestions: [],
    acceptanceCriteriaSeeds: [],
    endedBy: "consensus",
    transcriptHash: "hash",
  };
}

describe("persistent consultation with FileSystemRunStore", () => {
  it("persists state, transcript, and conclusion in the same layout the UI reads", async () => {
    const root = await tempRoot();
    const runStore = new FileSystemRunStore({
      rootDir: root,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
      randomId: () => "c0ns01",
    });
    const observed: string[] = [];

    const result = await runPersistentConsultation({
      repository: "owner/repo",
      repositoryPath: "/repo",
      remoteIdentity: "github.com/owner/repo",
      artifactRoot: path.join(root, "agent-artifacts"),
      topic: "設計相談",
      limits: { maxTurns: 4, maxDurationMs: 60_000, turnTimeoutMs: 1_000 },
    }, {
      runStore,
      createStore: (runId) => new FileSystemDiscussionStore({ runStore, runId }),
      discussants: [fakeAgent("claude-code")],
      summarizer: fakeAgent("summarizer"),
      parseEnvelope: (text) => ({ ok: true, envelope: JSON.parse(text) }),
      summarize: async ({ brief }) => conclusion(brief.topic),
      onStateChange: async (state) => {
        if ((await runStore.load(state.runId)) !== null) {
          observed.push(state.status);
        }
      },
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    });

    expect(result.status).toBe("completed");
    expect(observed[0]).toBe("created");
    const state = await runStore.load(result.runId);
    expect(state).toMatchObject({
      command: "consult",
      issueNumber: null,
      status: "completed",
      branch: null,
      baseSha: null,
    });
    const runDir = await runStore.runDirectory(result.runId);
    expect(runDir).toContain(path.join("owner", "repo", "consultations"));
    expect(runDir).not.toContain("issue-0");

    const store = new FileSystemDiscussionStore({ runStore, runId: result.runId });
    await expect(store.readTurns()).resolves.toHaveLength(1);
    await expect(store.readConclusion()).resolves.toMatchObject({ topic: "設計相談" });
    await expect(runStore.readArtifact(result.runId, "approval.json")).resolves.toBeNull();
    await expect(runStore.readArtifact(result.runId, "discuss-to-pr.json")).resolves.toBeNull();
    await expect(runStore.readArtifact(result.runId, "consultation-input.json")).resolves.toMatchObject({
      artifactType: "consultation-input",
      topic: "設計相談",
    });
  });
});
