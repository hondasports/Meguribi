import type { IssueRecord } from "../delivery.js";
import type { PlanArtifact } from "../codex-artifact.js";
import { describe, expect, it } from "vitest";
import { IMPLEMENTATION_PLAN_MARKER, planIssue } from "./plan.js";

const issue: IssueRecord = {
  number: 12,
  title: "Add planning",
  body: "Create a technical plan.",
  labels: [],
  comments: [],
  updatedAt: "2026-07-29T00:00:00.000Z",
};

const plan: PlanArtifact = {
  schemaVersion: 1,
  artifactType: "implementation-plan",
  summary: "Add the planning command",
  requirements: ["Create a plan"],
  acceptanceCriteria: ["No repository files change"],
  outOfScope: ["Pull request creation"],
  proposedFiles: ["apps/cli/src/commands/plan.ts"],
  steps: ["Add the use case", "Add tests"],
  risks: ["Stale Issue context"],
  tests: ["Unit test"],
  humanDecisions: [],
  unresolvedItems: [],
  metadata: {
    schemaVersion: 1,
    artifactId: "plan-12",
    createdAt: "2026-07-29T00:00:00.000Z",
    durationMs: 10,
    producer: { kind: "codex", role: "planner", threadId: "thread-12" },
    sourceDigests: { issue: "sha256:test" },
    eventLog: [],
  },
};

describe("planIssue", () => {
  it("creates one artifact and updates the stable Issue marker", async () => {
    const saved: string[] = [];
    const comments: Array<{ marker: string; body: string }> = [];
    const result = await planIssue(
      {
        repository: "owner/repo",
        issueNumber: 12,
        repositoryPath: "C:/repo",
        repositoryRules: "Follow AGENTS.md",
        completionCriteria: ["Tests pass"],
        outOfScope: [],
      },
      {
        github: {
          getIssue: async () => issue,
          upsertMarkerComment: async (input) => {
            comments.push({ marker: input.marker, body: input.body });
            return { commentId: 7 };
          },
        },
        codex: { createPlan: async () => plan },
        planStore: {
          save: async (input) => {
            saved.push(input.plan.summary);
            return "C:/data/meguribi/plans/owner/repo/issue-12/plan.json";
          },
        },
      },
    );

    expect(result.artifactPath).toContain("issue-12/plan.json");
    expect(saved).toEqual([plan.summary]);
    expect(comments[0]?.marker).toBe(IMPLEMENTATION_PLAN_MARKER);
    expect(comments[0]?.body).toContain("### Proposed steps");
    expect(comments[0]?.body).toContain("- Add the use case");
  });

  it("fails closed for an invalid Codex artifact", async () => {
    await expect(
      planIssue(
        {
          repository: "owner/repo",
          issueNumber: 12,
          repositoryPath: "C:/repo",
          repositoryRules: "Follow AGENTS.md",
          completionCriteria: [],
          outOfScope: [],
        },
        {
          github: { getIssue: async () => issue, upsertMarkerComment: async () => ({ commentId: 1 }) },
          codex: { createPlan: async () => ({ ...plan, artifactType: "bad" } as never) },
          planStore: { save: async () => "unused" },
        },
      ),
    ).rejects.toThrow("invalid implementation plan");
  });
});
