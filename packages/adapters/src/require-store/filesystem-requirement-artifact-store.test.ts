import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSystemRequirementArtifactStore } from "./filesystem-requirement-artifact-store.js";

describe("FileSystemRequirementArtifactStore", () => {
  it("stores a Requirement artifact under an Issue-scoped repository path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-requirement-"));
    try {
      const store = new FileSystemRequirementArtifactStore({ rootDir: root });
      const artifact = {
        schemaVersion: 1 as const,
        artifactType: "requirements" as const,
        repository: "owner/repo",
        sourceIssueNumber: 12,
        sourceIssueUrl: "https://github.com/owner/repo/issues/12",
        generatedAt: "2026-07-30T00:00:00.000Z",
        status: "draft" as const,
        humanApprovalRequired: true as const,
        selectedSolution: { number: 1, statement: "A" },
        problem: null,
        targetUsers: [],
        requirements: [],
        acceptanceCriteria: [],
        outOfScope: [],
        successMetrics: [],
        guardrails: [],
        openQuestions: ["requirements"],
        relatedIssues: { hypothesis: [12], problem: [12] },
      };
      const artifactPath = await store.save({ repository: "owner/repo", sourceIssueNumber: 12, artifact });
      expect(artifactPath).toBe(path.join(root, "requirements", "owner", "repo", "from-issue-12", "requirements.json"));
      await expect(fs.readFile(artifactPath, "utf8")).resolves.toContain('"artifactType": "requirements"');
      await expect(store.save({ repository: "../repo", sourceIssueNumber: 12, artifact })).rejects.toThrow(/Invalid repository/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
