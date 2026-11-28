import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemRunStore, FileSystemWorkflowEventLog } from "@meguribi/adapters";
import type {
  DiscussionConclusion,
  DiscussionDependencies,
  RunDiscussionWorkflowInput,
  RunState,
  WorkflowEvent,
} from "@meguribi/core";
import { runDiscussCommand, type DiscussionCommandDeps } from "./discuss.js";
import type { DiscussionWiringDependencies } from "../wiring/create-delivery-deps.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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

function discussionTurn(
  runId: string,
  message: string,
): Extract<WorkflowEvent, { type: "discussion.turn" }> {
  return {
    type: "discussion.turn",
    runId,
    turn: {
      turnId: "t-1",
      speaker: "codex",
      speakerLabel: "Codex",
      envelope: {
        message,
        replyTo: [],
        addressTo: [],
        positions: [],
        newIssues: [],
        done: false,
      },
      malformed: false,
      at: "2026-11-28T12:00:00.000Z",
    },
    turnNumber: 1,
    maxTurns: 20,
  };
}

function discussionEnded(runId: string): Extract<WorkflowEvent, { type: "discussion.ended" }> {
  return {
    type: "discussion.ended",
    runId,
    endedBy: "consensus",
    turns: 1,
    at: "2026-11-28T12:00:01.000Z",
  };
}

async function createFixture(input: {
  events: (runId: string) => readonly WorkflowEvent[];
}): Promise<{
  deps: DiscussionCommandDeps;
  stdout: string[];
  stderr: string[];
  runStore: FileSystemRunStore;
  state: RunState;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-discussion-pipeline-"));
  temps.push(root);
  const runStore = new FileSystemRunStore({
    rootDir: root,
    now: () => new Date("2026-11-28T12:00:00.000Z"),
    randomId: () => "abc123",
  });
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
  const wiring: DiscussionWiringDependencies = {
    github: {} as DiscussionWiringDependencies["github"],
    git: {} as DiscussionWiringDependencies["git"],
    policy: {} as DiscussionWiringDependencies["policy"],
    runStore,
    discussants: [],
    summarizer: {} as DiscussionWiringDependencies["summarizer"],
    parseEnvelope: () => ({ ok: false, reason: "not used" }),
    summarize: async () => conclusionFixture(),
    hashConclusion: () => "hash",
    createStore: () => {
      throw new Error("not used");
    },
    now: () => new Date("2026-11-28T12:00:00.000Z"),
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: DiscussionCommandDeps = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    createDependencies: async () => wiring,
    runWorkflow: async (
      _input: RunDiscussionWorkflowInput,
      workflowDeps: DiscussionDependencies,
    ) => {
      for (const event of input.events(state.runId)) {
        workflowDeps.onWorkflowEvent?.(event);
      }
      return {
        runId: state.runId,
        status: "awaiting_human",
        conclusion: conclusionFixture(),
        reasons: [],
      };
    },
  };
  return { deps, stdout, stderr, runStore, state };
}

describe("discussion event pipeline", () => {
  it("persists workflow lifecycle events independently from live-log rendering", async () => {
    const fixture = await createFixture({
      events: (runId) => [
        { type: "workflow.started", runId, workflow: "discuss", at: "2026-11-28T12:00:00.000Z" },
        discussionTurn(runId, "stream message"),
        discussionEnded(runId),
      ],
    });

    const result = await runDiscussCommand("owner/repo#83", {}, fixture.deps);

    expect(result.exitCode).toBe(0);
    const log = new FileSystemWorkflowEventLog({ runStore: fixture.runStore });
    const records = await log.read(fixture.state.runId);
    expect(records.records.map((record) => record.event.type)).toEqual([
      "workflow.started",
      "discussion.turn",
      "discussion.ended",
    ]);
    const rendered = fixture.stderr.join("");
    expect(rendered).toContain("stream message");
    expect(rendered.split("stream message").length - 1).toBe(1);
  });

  it("does not render live logs when --json is set", async () => {
    const fixture = await createFixture({
      events: (runId) => [discussionTurn(runId, "json mode should be quiet")],
    });

    const result = await runDiscussCommand("owner/repo#83", { json: true }, fixture.deps);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(fixture.stdout.join(""))).toMatchObject({
      runId: fixture.state.runId,
      status: "awaiting_human",
    });
    expect(fixture.stderr.join("")).toBe("");
    const log = new FileSystemWorkflowEventLog({ runStore: fixture.runStore });
    const records = await log.read(fixture.state.runId);
    expect(records.records.map((record) => record.event.type)).toEqual(["discussion.turn"]);
  });

  it("does not render live logs when --log none is set", async () => {
    const fixture = await createFixture({
      events: (runId) => [discussionTurn(runId, "none mode should be quiet")],
    });

    const result = await runDiscussCommand("owner/repo#83", { log: "none" }, fixture.deps);

    expect(result.exitCode).toBe(0);
    expect(fixture.stderr.join("")).toBe("");
    const log = new FileSystemWorkflowEventLog({ runStore: fixture.runStore });
    const records = await log.read(fixture.state.runId);
    expect(records.records.map((record) => record.event.type)).toEqual(["discussion.turn"]);
  });

  it("renders only the first 80 message characters in compact mode", async () => {
    const message = "a".repeat(90);
    const fixture = await createFixture({
      events: (runId) => [discussionTurn(runId, message)],
    });

    const result = await runDiscussCommand("owner/repo#83", { log: "compact" }, fixture.deps);

    expect(result.exitCode).toBe(0);
    const output = fixture.stderr.join("");
    expect(output).toContain("a".repeat(80));
    expect(output).not.toContain("a".repeat(81));
  });
});
