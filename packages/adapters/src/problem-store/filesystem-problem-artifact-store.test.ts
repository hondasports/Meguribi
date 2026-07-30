import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSystemProblemArtifactStore } from "./filesystem-problem-artifact-store.js";

describe("FileSystemProblemArtifactStore", () => {
  it("stores a Problem draft under the source Issue", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-problem-"));
    try {
      const store = new FileSystemProblemArtifactStore({ rootDir: root });
      const artifact = {
        schemaVersion: 1 as const,
        artifactType: "problem" as const,
        repository: "owner/repo",
        sourceIssueNumber: 12,
        sourceIssueUrl: "https://github.com/owner/repo/issues/12",
        generatedAt: "2026-07-30T00:00:00.000Z",
        status: "draft" as const,
        humanApprovalRequired: true as const,
        title: "Problem: Registration",
        problem: "Some users cannot register",
        targetUser: null,
        evidence: ["A report"],
        userImpact: null,
        currentWorkaround: null,
        unconfirmedItems: ["target user"],
        relatedHypothesis: "https://github.com/owner/repo/issues/12",
      };
      const artifactPath = await store.save({ repository: "owner/repo", sourceIssueNumber: 12, artifact });
      expect(artifactPath).toBe(path.join(root, "problems", "owner", "repo", "from-issue-12", "problem.json"));
      await expect(fs.readFile(artifactPath, "utf8")).resolves.toContain('"artifactType": "problem"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
