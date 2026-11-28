import { describe, expect, it } from "vitest";
import type { RoleAgent } from "../role-agent.js";
import type { RunState, RunStore } from "../delivery.js";
import { runConsultation, runPersistentConsultation } from "./consultation.js";
import type { DiscussionConclusion, DiscussionTurn } from "./types.js";

function envelopeText(done: boolean): string {
  return JSON.stringify({
    message: "read-only consultation answer",
    replyTo: [],
    addressTo: [],
    positions: [],
    newIssues: [],
    done,
  });
}

function fakeAgent(id: string, openInputs: unknown[]): RoleAgent {
  return {
    profileId: id,
    kind: "claude-code",
    async openSession(input: Parameters<RoleAgent["openSession"]>[0]) {
      openInputs.push(input);
      return {
        sessionId: `session-${id}`,
        async send() {
          return { sessionId: `session-${id}`, text: envelopeText(true), events: [] };
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

describe("runConsultation", () => {
  it("runs an issue-free read-only consultation and stores only per-run discussion artifacts", async () => {
    const openInputs: unknown[] = [];
    const storedTurns: DiscussionTurn[] = [];
    const storedConclusions: DiscussionConclusion[] = [];
    const result = await runConsultation({
      runId: "consult-1",
      cwd: "/repo",
      artifactRoot: "/artifacts/consult-1",
      topic: "設計について相談したい",
      userRequest: "実装はまだしない",
      limits: { maxTurns: 4, maxDurationMs: 60_000, turnTimeoutMs: 1_000 },
      store: {
        async appendTurn(turn) { storedTurns.push(turn); },
        async readHumanMessages() { return []; },
        async saveConclusion(value) { storedConclusions.push(value); },
      },
    }, {
      discussants: [fakeAgent("claude-code", openInputs)],
      summarizer: fakeAgent("summarizer", openInputs),
      parseEnvelope: (text) => ({ ok: true, envelope: JSON.parse(text) }),
      summarize: async ({ brief }) => conclusion(brief.topic),
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    });

    expect(result.endedBy).toBe("consensus");
    expect(result.conclusion.conclusion).toBe("consulted");
    expect(openInputs[0]).toMatchObject({
      cwd: "/repo",
      mode: "read-only",
      role: "discussant",
      artifactRoot: "/artifacts/consult-1/claude-code",
    });
    expect(storedTurns).toHaveLength(1);
    expect(storedConclusions[0]?.topic).toBe("設計について相談したい");
  });

  it("rejects an empty consultation topic", async () => {
    await expect(runConsultation({
      runId: "consult-1",
      cwd: "/repo",
      artifactRoot: "/artifacts/consult-1",
      topic: " ",
      limits: { maxTurns: 4, maxDurationMs: 60_000, turnTimeoutMs: 1_000 },
    }, {
      discussants: [fakeAgent("claude-code", [])],
      summarizer: fakeAgent("summarizer", []),
      parseEnvelope: (text) => ({ ok: true, envelope: JSON.parse(text) }),
      summarize: async ({ brief }) => conclusion(brief.topic),
    })).rejects.toThrow("topic");
  });
});


function memoryRunStore(): RunStore & { states: Map<string, RunState>; artifacts: Map<string, Map<string, unknown>> } {
  const states = new Map<string, RunState>();
  const artifacts = new Map<string, Map<string, unknown>>();
  let sequence = 0;
  return {
    states,
    artifacts,
    async create(input) {
      sequence += 1;
      const runId = `consult-run-${String(sequence)}`;
      const createdAt = "2026-07-26T12:00:00.000Z";
      const base = {
        schemaVersion: 1 as const,
        runId,
        repository: input.repository,
        status: "created" as const,
        completedSteps: [],
        pullRequestNumber: null,
        agentSessions: {},
        fixAttempts: 0,
        maxFixAttempts: input.maxFixAttempts,
        createdAt,
        updatedAt: createdAt,
      };
      const state: RunState = input.command === "consult"
        ? {
            ...base,
            command: "consult",
            issueNumber: null,
            branch: null,
            worktreePath: input.consultation.worktreePath,
            baseRef: null,
            baseSha: null,
            headSha: null,
            remoteIdentity: input.consultation.remoteIdentity,
          }
        : {
            ...base,
            command: input.command,
            issueNumber: input.issueNumber,
            branch: input.identity.branch,
            worktreePath: input.identity.worktreePath,
            baseRef: input.identity.baseRef,
            baseSha: input.identity.baseSha,
            headSha: input.identity.headSha,
            remoteIdentity: input.identity.remoteIdentity,
          };
      states.set(runId, state);
      artifacts.set(runId, new Map());
      return structuredClone(state);
    },
    async load(runId) {
      const state = states.get(runId);
      return state ? structuredClone(state) : null;
    },
    async loadLatest() { return null; },
    async update(runId, patch) {
      const current = states.get(runId);
      if (!current) throw new Error(`Run not found: ${runId}`);
      const next = { ...current, ...patch, runId, updatedAt: patch.updatedAt ?? "2026-07-26T12:00:01.000Z" } as RunState;
      states.set(runId, next);
      return structuredClone(next);
    },
    async saveArtifact(runId, name, value) {
      const map = artifacts.get(runId) ?? new Map<string, unknown>();
      map.set(name, value);
      artifacts.set(runId, map);
      return `memory://${runId}/${name}`;
    },
    async readArtifact<T>(runId: string, name: string): Promise<T | null> {
      const value = artifacts.get(runId)?.get(name);
      return value === undefined ? null : structuredClone(value) as T;
    },
    async acquireLock() {},
    async releaseLock() {},
  };
}

function persistentInput(overrides: Record<string, unknown> = {}) {
  return {
    repository: "owner/repo",
    repositoryPath: "/repo",
    remoteIdentity: "github.com/owner/repo",
    artifactRoot: "/artifacts/consultation",
    topic: "設計について相談したい",
    userRequest: "実装はまだしない",
    limits: { maxTurns: 4, maxDurationMs: 60_000, turnTimeoutMs: 1_000 },
    ...overrides,
  };
}

describe("runPersistentConsultation", () => {
  it("creates a persistent issue-less consultation run and stores turns, conclusion, and completed state", async () => {
    const openInputs: unknown[] = [];
    const runStore = memoryRunStore();
    const storedTurns = new Map<string, DiscussionTurn[]>();
    const storedConclusions = new Map<string, DiscussionConclusion>();
    const stateNotifications: RunState[] = [];
    const result = await runPersistentConsultation(persistentInput({
      artifactRoot: (runId: string) => `/artifacts/${runId}`,
    }), {
      runStore,
      createStore: (runId) => ({
        async appendTurn(turn) {
          const turns = storedTurns.get(runId) ?? [];
          turns.push(turn);
          storedTurns.set(runId, turns);
        },
        async readHumanMessages() { return []; },
        async saveConclusion(value) { storedConclusions.set(runId, value); },
      }),
      discussants: [fakeAgent("claude-code", openInputs)],
      summarizer: fakeAgent("summarizer", openInputs),
      parseEnvelope: (text) => ({ ok: true, envelope: JSON.parse(text) }),
      summarize: async ({ brief }) => conclusion(brief.topic),
      onStateChange: (state) => { stateNotifications.push(structuredClone(state)); },
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.runId).toBe("consult-run-1");
    expect(result.conclusion?.conclusion).toBe("consulted");
    const persisted = runStore.states.get(result.runId);
    expect(persisted).toMatchObject({
      command: "consult",
      issueNumber: null,
      status: "completed",
      branch: null,
      baseSha: null,
      worktreePath: "/repo",
      remoteIdentity: "github.com/owner/repo",
    });
    expect(storedTurns.get(result.runId)).toHaveLength(1);
    expect(storedConclusions.get(result.runId)?.topic).toBe("設計について相談したい");
    expect(runStore.artifacts.get(result.runId)?.has("approval.json")).toBe(false);
    expect(runStore.artifacts.get(result.runId)?.has("discuss-to-pr.json")).toBe(false);
    expect(runStore.artifacts.get(result.runId)?.has("consultation-input.json")).toBe(true);
    expect(stateNotifications[0]).toMatchObject({ runId: result.runId, status: "created" });
    expect(openInputs[0]).toMatchObject({
      mode: "read-only",
      cwd: "/repo",
      artifactRoot: "/artifacts/consult-run-1/claude-code",
    });
    expect(runStore.artifacts.get(result.runId)?.get("consultation-input.json")).toMatchObject({
      artifactRoot: "/artifacts/consult-run-1",
    });
  });

  it("persists a failed state with partial discussion artifacts when the consultation errors", async () => {
    const runStore = memoryRunStore();
    const failingAgent: RoleAgent = {
      profileId: "claude-code",
      kind: "claude-code",
      async openSession() {
        throw new Error("agent startup failed");
      },
    } as unknown as RoleAgent;
    const result = await runPersistentConsultation(persistentInput(), {
      runStore,
      createStore: () => ({
        async appendTurn() {},
        async readHumanMessages() { return []; },
        async saveConclusion() {},
      }),
      discussants: [failingAgent],
      summarizer: fakeAgent("summarizer", []),
      parseEnvelope: (text) => ({ ok: true, envelope: JSON.parse(text) }),
      summarize: async ({ brief }) => conclusion(brief.topic),
    });

    expect(result.status).toBe("failed");
    expect(result.reasons.join("\n")).toContain("agent startup failed");
    expect(runStore.states.get(result.runId)).toMatchObject({
      status: "failed",
      lastError: { code: "unknown" },
    });
  });

  it("persists cancelled state when the consultation is cancelled", async () => {
    const runStore = memoryRunStore();
    const cancelled = new Error("discussion cancelled") as Error & { code: "cancelled" };
    cancelled.code = "cancelled";
    const cancelledAgent: RoleAgent = {
      profileId: "claude-code",
      kind: "claude-code",
      async openSession() { throw cancelled; },
    } as unknown as RoleAgent;
    const result = await runPersistentConsultation(persistentInput(), {
      runStore,
      createStore: () => ({
        async appendTurn() {},
        async readHumanMessages() { return []; },
        async saveConclusion() {},
      }),
      discussants: [cancelledAgent],
      summarizer: fakeAgent("summarizer", []),
      parseEnvelope: (text) => ({ ok: true, envelope: JSON.parse(text) }),
      summarize: async ({ brief }) => conclusion(brief.topic),
    });

    expect(result.status).toBe("cancelled");
    expect(runStore.states.get(result.runId)?.status).toBe("cancelled");
  });
});
