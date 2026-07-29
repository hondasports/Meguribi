import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemPlanArtifactStore } from "./filesystem-plan-artifact-store.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("FileSystemPlanArtifactStore", () => {
  it("writes the latest plan atomically under the repository Issue", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-plan-store-"));
    temps.push(root);
    const store = new FileSystemPlanArtifactStore({ rootDir: root });
    const artifact = { schemaVersion: 1, artifactType: "implementation-plan", summary: "first" };

    const saved = await store.save({ repository: "owner/repo", issueNumber: 3, plan: artifact as never });
    expect(saved).toBe(path.join(root, "plans", "owner", "repo", "issue-3", "plan.json"));
    await expect(fs.readFile(saved, "utf8")).resolves.toContain('"summary": "first"');
  });

  it("rejects path traversal in repository identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-plan-store-"));
    temps.push(root);
    const store = new FileSystemPlanArtifactStore({ rootDir: root });
    await expect(store.save({ repository: "../repo", issueNumber: 1, plan: {} as never })).rejects.toThrow();
  });
});
