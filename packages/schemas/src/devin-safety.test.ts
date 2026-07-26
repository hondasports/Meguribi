import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { AgentTerminationResultSchema, ImplementationContextSchema, PermissionRequestSchema } from "./devin-safety.js";

describe("Devin safety schemas", () => {
  it("accepts the normalized safety payloads", () => {
    expect(v.parse(PermissionRequestSchema, {
      requestId: "r", sessionId: "s", operation: "file_read", tool: "read", summary: "read",
      targetWithinWorktree: true, protectedPath: false, destructive: false, network: false,
    }).operation).toBe("file_read");
    expect(v.parse(ImplementationContextSchema, {
      issue: { source: "issue", content: "body" }, comments: [], acceptanceCriteria: [],
      plan: { summary: "plan", steps: [] }, repositoryRules: "rules", primarySkill: "skill",
      verificationCommands: [], protectedPaths: [], worktreePath: "C:/worktree", allowedPaths: ["."],
      limits: { maxPromptChars: 100, maxChangedFiles: 1, maxDiffLines: 1 }, expectedResult: [],
    }).plan.summary).toBe("plan");
    expect(v.parse(AgentTerminationResultSchema, {
      reason: "completed", stdinClosed: true, cancelSent: false, gracefulExit: true,
      terminateSent: false, forceKillUsed: false, residualProcesses: 0,
    }).residualProcesses).toBe(0);
  });

  it("rejects unknown operations and unsafe termination counts", () => {
    expect(v.safeParse(PermissionRequestSchema, {
      requestId: "r", sessionId: "s", operation: "allow_all", tool: "x", summary: "x",
      targetWithinWorktree: true, protectedPath: false, destructive: false, network: false,
    }).success).toBe(false);
    expect(v.safeParse(AgentTerminationResultSchema, {
      reason: "completed", stdinClosed: true, cancelSent: false, gracefulExit: true,
      terminateSent: false, forceKillUsed: false, residualProcesses: -1,
    }).success).toBe(false);
  });
});
