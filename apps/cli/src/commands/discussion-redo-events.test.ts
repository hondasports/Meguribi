import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemRunStore, FileSystemWorkflowEventLog } from "@meguribi/adapters";
import type { DiscussionConclusion, WorkflowEvent } from "@meguribi/core";
import { runRejectCommand, type DiscussionCommandDeps } from "./discuss.js";
import type { DiscussionWiringDependencies } from "../wiring/create-delivery-deps.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function conclusionFixture(): DiscussionConclusion {
  return {
    topic: "topic",
    conclusion: "やり直し後の新しい結論",
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
      turnId: "t-3",
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

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-discussion-redo-"));
  temps.push(root);
  const runStore = new FileSystemRunStore({
    rootDir: root,
    now: () => new Date("2026-11-28T12:00:00.000Z"),
    randomId: () => "abc123",
  });
  const created = await runStore.create({
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
  const state = await runStore.update(created.runId, { status: "awaiting_human" });
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
    runStore,
    resolveApprover: async () => "tester",
    createDependencies: async () => wiring,
    rejectWorkflow: async (_input, workflowDeps) => {
      const events: WorkflowEvent[] = [
        {
          type: "workflow.started",
          runId: state.runId,
          workflow: "discuss",
          at: "2026-11-28T12:00:00.000Z",
        },
        discussionTurn(state.runId, "redo live message"),
        {
          type: "discussion.ended",
          runId: state.runId,
          endedBy: "consensus",
          turns: 1,
          at: "2026-11-28T12:00:01.000Z",
        },
      ];
      for (const event of events) {
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

describe("reject --redo event pipeline", () => {
  it("persists and renders redo discussion events, then prints the new conclusion and next actions", async () => {
    const fixture = await createFixture();

    const result = await runRejectCommand(
      fixture.state.runId,
      { reason: "やり直して", redo: true },
      fixture.deps,
    );

    expect(result.exitCode).toBe(0);
    const log = new FileSystemWorkflowEventLog({ runStore: fixture.runStore });
    const records = await log.read(fixture.state.runId);
    expect(records.records.map((record) => record.event.type)).toEqual([
      "workflow.started",
      "discussion.turn",
      "discussion.ended",
    ]);

    const rendered = fixture.stderr.join("");
    expect(rendered).toContain("redo live message");
    expect(rendered.split("redo live message").length - 1).toBe(1);

    const output = fixture.stdout.join("");
    expect(output).toContain("やり直し後の新しい結論");
    expect(output).toContain(`Next: meguribi approve ${fixture.state.runId}`);
    expect(output).toContain(`meguribi reject ${fixture.state.runId} --reason "..." [--redo]`);
  });
});
