import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  DiscussionConclusionContentSchema,
  DiscussionConclusionSchema,
  DiscussionEnvelopeSchema,
} from "./discussion.js";
import { RunStateSchema } from "./run-state.js";

const conclusionContent = {
  topic: "通知 timing",
  conclusion: "夜間通知は朝にまとめる",
  issues: [
    {
      issue: "通知のタイミング",
      positions: [{ participant: "codex", stance: "夜間はまとめるべき", turnIds: ["t-1"] }],
      resolution: "朝にまとめて送る",
    },
  ],
  rejectedOptions: [{ option: "通知量の上限", reason: "重要通知も落ちる", turnIds: ["t-2"] }],
  openQuestions: ["通知チャネルを増やすか"],
  acceptanceCriteriaSeeds: ["夜間の通知が朝にまとめられる"],
};

describe("DiscussionEnvelopeSchema", () => {
  it("fills default fields for a minimal envelope", () => {
    expect(v.parse(DiscussionEnvelopeSchema, { message: "x" })).toEqual({
      message: "x",
      replyTo: [],
      addressTo: [],
      positions: [],
      newIssues: [],
      done: false,
    });
  });

  it("rejects an empty message", () => {
    const result = v.safeParse(DiscussionEnvelopeSchema, { message: "" });
    expect(result.success).toBe(false);
  });
});

describe("DiscussionConclusionContentSchema", () => {
  it("parses valid conclusion content", () => {
    expect(v.parse(DiscussionConclusionContentSchema, conclusionContent)).toEqual(
      conclusionContent,
    );
  });

  it("rejects unknown keys in conclusion content", () => {
    const result = v.safeParse(DiscussionConclusionContentSchema, {
      ...conclusionContent,
      unexpected: "must not pass",
    });
    expect(result.success).toBe(false);
  });
});

describe("DiscussionConclusionSchema", () => {
  it("parses conclusion content with end metadata", () => {
    const conclusion = {
      ...conclusionContent,
      endedBy: "consensus",
      transcriptHash: "abc123",
    };
    expect(v.parse(DiscussionConclusionSchema, conclusion)).toEqual(conclusion);
  });
});

describe("RunStateSchema discussion values", () => {
  it("accepts command discuss and status completed", () => {
    const state = {
      schemaVersion: 1,
      runId: "run-1",
      repository: "owner/repo",
      issueNumber: 83,
      command: "discuss",
      status: "completed",
      completedSteps: [],
      branch: "meguribi/issue-83",
      worktreePath: "/tmp/worktree",
      baseRef: "origin/main",
      baseSha: "base",
      headSha: "head",
      remoteIdentity: "github.com/owner/repo",
      pullRequestNumber: null,
      agentSessions: {},
      fixAttempts: 0,
      maxFixAttempts: 1,
      createdAt: "2026-11-28T00:00:00.000Z",
      updatedAt: "2026-11-28T00:00:00.000Z",
    };
    const result = v.safeParse(RunStateSchema, state);
    expect(result.success).toBe(true);
  });
});
