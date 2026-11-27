import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpAgentArtifactStore } from "./artifact-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meguribi-acp-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

describe("AcpAgentArtifactStore", () => {
  it("uses the label-scoped prompt file name and creates the root on init", async () => {
    const base = await tempRoot();
    const root = path.join(base, "nested", "artifacts");
    const store = new AcpAgentArtifactStore(root, {
      label: "Claude Code",
      promptFileName: "claude-code-prompt.md",
    });

    expect(store.promptPath).toBe(path.join(root, "claude-code-prompt.md"));

    await store.init();

    await expect(fs.access(root)).resolves.toBeUndefined();
  });
});
