import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { RunStateSchema } from "./run-state.js";

function issueRunState() {
  return {
    schemaVersion: 1,
    runId: "run-1",
    repository: "owner/repo",
    issueNumber: 22,
    command: "discuss",
    status: "created",
    completedSteps: [],
    branch: "meguribi/issue-22",
    worktreePath: "/tmp/worktree",
    baseRef: "origin/main",
    baseSha: "base-sha",
    headSha: "head-sha",
    remoteIdentity: "github.com/owner/repo",
    pullRequestNumber: null,
    agentSessions: {},
    fixAttempts: 0,
    maxFixAttempts: 0,
    createdAt: "2026-07-26T12:00:00.000Z",
    updatedAt: "2026-07-26T12:00:00.000Z",
  };
}

function consultationRunState() {
  return {
    ...issueRunState(),
    command: "consult",
    issueNumber: null,
    branch: null,
    worktreePath: "/tmp/repository",
    baseRef: null,
    baseSha: null,
    headSha: null,
  };
}

describe("RunStateSchema consultation runs", () => {
  it("accepts an issue-less consultation run with explicit null identity fields", () => {
    const result = v.safeParse(RunStateSchema, consultationRunState());
    expect(result.success).toBe(true);
  });

  it("keeps the positive issue number contract for issue-backed runs", () => {
    for (const command of ["run", "resume", "discuss"] as const) {
      const result = v.safeParse(RunStateSchema, {
        ...issueRunState(),
        command,
        issueNumber: null,
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects fake numeric issue numbers and fake branch identity on consultation runs", () => {
    expect(v.safeParse(RunStateSchema, {
      ...consultationRunState(),
      issueNumber: 0,
    }).success).toBe(false);
    expect(v.safeParse(RunStateSchema, {
      ...consultationRunState(),
      branch: "consultation",
    }).success).toBe(false);
  });
});
