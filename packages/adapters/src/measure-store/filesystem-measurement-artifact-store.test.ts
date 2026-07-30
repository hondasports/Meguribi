import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSystemMeasurementArtifactStore } from "./filesystem-measurement-artifact-store.js";

describe("FileSystemMeasurementArtifactStore", () => {
  it("stores a measurement artifact under an Issue-scoped repository path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-measurement-"));
    try {
      const store = new FileSystemMeasurementArtifactStore({ rootDir: root });
      const artifact = { schemaVersion: 1 as const, artifactType: "measurement" as const, repository: "owner/repo", sourceIssueNumber: 12, sourceIssueUrl: "https://github.com/owner/repo/issues/12", pullRequestNumber: 42, pullRequestUrl: "https://github.com/owner/repo/pull/42", generatedAt: "2026-08-01T00:00:00.000Z", humanApprovalRequired: true as const, originalHypothesis: null, period: { from: "2026-08-01", to: "2026-08-14" }, metrics: [], qualitativeEvidence: [], result: "inconclusive" as const, recommendedNextAction: "collect_more_data" as const, nextHypothesisCandidates: [], openQuestions: ["result"] };
      const artifactPath = await store.save({ repository: "owner/repo", sourceIssueNumber: 12, artifact });
      expect(artifactPath).toBe(path.join(root, "measurements", "owner", "repo", "from-issue-12", "measurement.json"));
      await expect(fs.readFile(artifactPath, "utf8")).resolves.toContain('"artifactType": "measurement"');
      await expect(store.save({ repository: "../repo", sourceIssueNumber: 12, artifact })).rejects.toThrow(/Invalid repository/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
