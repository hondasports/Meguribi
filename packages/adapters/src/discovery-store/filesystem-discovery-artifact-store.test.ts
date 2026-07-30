import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemDiscoveryArtifactStore } from "./filesystem-discovery-artifact-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("FileSystemDiscoveryArtifactStore", () => {
  it("atomically saves the latest discovery artifact per repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-discovery-store-"));
    roots.push(root);
    const store = new FileSystemDiscoveryArtifactStore({ rootDir: root });
    const artifact = { schemaVersion: 1, artifactType: "discovery", repository: "owner/repo" } as never;

    const saved = await store.save({ repository: "owner/repo", artifact });
    expect(saved).toBe(path.join(root, "discoveries", "owner", "repo", "discovery.json"));
    await expect(fs.readFile(saved, "utf8")).resolves.toContain('"artifactType": "discovery"');
  });
});
