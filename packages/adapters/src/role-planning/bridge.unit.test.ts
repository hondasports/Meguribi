import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentPrompt, IssueRecord, RoleAgent, RoleSession, VerificationResult } from "@meguribi/core";
import { afterEach, describe, expect, it } from "vitest";
import { RoleSessionWriteViolationError } from "../acp-server/index.js";
import { createRoleAgentPlanningBridge, RolePlanningError } from "./bridge.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function tempGit(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-role-planning-"));
  tempRoots.push(root);
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

const planContent = {
  summary: "summary",
  requirements: ["requirement"],
  acceptanceCriteria: ["criterion"],
  outOfScope: ["out"],
  proposedFiles: ["src/feature.ts"],
  steps: ["step"],
  risks: ["risk"],
  tests: ["test"],
  humanDecisions: ["decision"],
  unresolvedItems: [],
};

function jsonFenced(value: unknown): string {
  return ["explanation text", "```json", JSON.stringify(value), "```"].join("\n");
}

interface ScriptedSession extends RoleSession {
  readonly prompts: string[];
}

function fakeRoleAgent(
  kind: RoleAgent["kind"],
  script: Array<string | Error>,
): { agent: RoleAgent; sessions: ScriptedSession[] } {
  const sessions: ScriptedSession[] = [];
  const agent: RoleAgent = {
    profileId: `${kind}-profile`,
    kind,
    async openSession(): Promise<RoleSession> {
      let index = 0;
      const prompts: string[] = [];
      const session: ScriptedSession = {
        sessionId: `session-${sessions.length + 1}`,
        prompts,
        async send(prompt: AgentPrompt) {
          prompts.push(prompt.content);
          const next = script[Math.min(index, script.length - 1)];
          index += 1;
          if (next instanceof Error) {
            throw next;
          }
          return { sessionId: session.sessionId, text: next, events: [] };
        },
        async close() {},
      };
      sessions.push(session);
      return session;
    },
  };
  return { agent, sessions };
}

function issue(): IssueRecord {
  return {
    number: 64,
    title: "issue title",
    body: "issue body",
    labels: [],
    comments: [],
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

function createBridge(agent: RoleAgent, artifactRoot: string) {
  return createRoleAgentPlanningBridge({
    planner: agent,
    reviewer: agent,
    artifactRoot,
    now: () => new Date("2026-07-26T00:00:00.000Z"),
  });
}

describe("createRoleAgentPlanningBridge", () => {
  it("retries in the same session and succeeds when the second response is valid", async () => {
    const repositoryPath = await tempGit();
    const { agent, sessions } = fakeRoleAgent("claude-code", [
      "no json here",
      jsonFenced(planContent),
    ]);
    const bridge = createBridge(agent, path.join(repositoryPath, ".artifacts"));

    const artifact = await bridge.createPlan({
      repositoryPath,
      issue: issue(),
      repositoryRules: "rules",
      completionCriteria: ["criterion"],
      outOfScope: [],
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.prompts).toHaveLength(2);
    expect(artifact.metadata.producer.kind).toBe("claude-code");
    expect(artifact.metadata.producer.role).toBe("planner");
    expect(artifact.metadata.producer.threadId).toBe("session-1");
    expect(artifact.metadata.eventLog).toEqual([]);
    expect(artifact.summary).toBe("summary");
  });

  it("repairs with a fenceless bare JSON object and includes the fence instruction in the repair prompt", async () => {
    const repositoryPath = await tempGit();
    const { agent, sessions } = fakeRoleAgent("claude-code", [
      "explanation without any json",
      JSON.stringify(planContent),
    ]);
    const bridge = createBridge(agent, path.join(repositoryPath, ".artifacts"));

    const artifact = await bridge.createPlan({
      repositoryPath,
      issue: issue(),
      repositoryRules: "rules",
      completionCriteria: ["criterion"],
      outOfScope: [],
    });

    expect(sessions[0]?.prompts).toHaveLength(2);
    expect(sessions[0]?.prompts[1]).toContain("```json");
    expect(artifact.summary).toBe("summary");
  });

  it("throws malformed_output with attempts 3 when every response fails validation", async () => {
    const repositoryPath = await tempGit();
    const invalid = jsonFenced({ ...planContent, extraKey: "not allowed" });
    const { agent } = fakeRoleAgent("claude-code", [invalid, invalid, invalid]);
    const bridge = createBridge(agent, path.join(repositoryPath, ".artifacts"));

    const error = await bridge
      .createPlan({
        repositoryPath,
        issue: issue(),
        repositoryRules: "rules",
        completionCriteria: ["criterion"],
        outOfScope: [],
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RolePlanningError);
    expect((error as RolePlanningError).code).toBe("malformed_output");
    expect((error as RolePlanningError).attempts).toBe(3);
  });

  it("converts write violations into policy_blocked", async () => {
    const repositoryPath = await tempGit();
    const { agent } = fakeRoleAgent("claude-code", [
      new RoleSessionWriteViolationError(["README.md"]),
    ]);
    const bridge = createBridge(agent, path.join(repositoryPath, ".artifacts"));

    const error = await bridge
      .createPlan({
        repositoryPath,
        issue: issue(),
        repositoryRules: "rules",
        completionCriteria: ["criterion"],
        outOfScope: [],
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RolePlanningError);
    expect((error as RolePlanningError).code).toBe("policy_blocked");
  });

  it("produces a review artifact through the reviewer role", async () => {
    const repositoryPath = await tempGit();
    const reviewContent = {
      status: "approved",
      summary: "ok",
      requirementCoverage: [],
      findings: [],
      missingTests: [],
      scopeViolations: [],
      recommendedAction: "proceed",
    };
    const { agent, sessions } = fakeRoleAgent("codex", [jsonFenced(reviewContent)]);
    const bridge = createBridge(agent, path.join(repositoryPath, ".artifacts"));
    const verification: VerificationResult = {
      schemaVersion: 1,
      artifactType: "verification",
      success: true,
      commands: [],
    };

    const artifact = await bridge.review({
      repositoryPath,
      issue: issue(),
      plan: planContent,
      diff: "diff",
      changedFiles: ["README.md"],
      verification,
      repositoryRules: "rules",
    });

    expect(sessions).toHaveLength(1);
    expect(artifact.metadata.producer.kind).toBe("codex");
    expect(artifact.metadata.producer.role).toBe("reviewer");
    expect(artifact.status).toBe("approved");
  });
});
