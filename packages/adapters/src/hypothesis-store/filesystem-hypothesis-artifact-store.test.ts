import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSystemHypothesisArtifactStore } from "./filesystem-hypothesis-artifact-store.js";

describe("FileSystemHypothesisArtifactStore", () => {
  it("atomically stores an Issue-scoped artifact under a safe repository path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-hypothesis-"));
    try {
      const store = new FileSystemHypothesisArtifactStore({ rootDir: root });
      const artifact = {
        schemaVersion: 1 as const,
        artifactType: "hypothesis" as const,
        repository: "owner/repo",
        issueNumber: 12,
        generatedAt: "2026-07-30T00:00:00.000Z",
        status: "draft" as const,
        humanApprovalRequired: true as const,
        observations: [],
        problemCandidates: [],
        causeHypotheses: [],
        solutionHypotheses: [],
        counterHypotheses: [],
        validationMethods: [],
        successConditions: [],
        rejectionConditions: [],
        missingEvidence: ["観測"],
      };
      const artifactPath = await store.save({ repository: "owner/repo", issueNumber: 12, artifact });
      expect(artifactPath).toBe(path.join(root, "hypotheses", "owner", "repo", "issue-12", "hypothesis.json"));
      await expect(fs.readFile(artifactPath, "utf8")).resolves.toContain('"artifactType": "hypothesis"');
      await expect(store.save({ repository: "../repo", issueNumber: 12, artifact })).rejects.toThrow(/Invalid repository/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
