import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { normalizeAcpPermissionRequest } from "./permissions.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })),
  );
});

function probeSymlinkCreation(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "meguribi-symlink-probe-"));
  try {
    fs.symlinkSync(probe, path.join(probe, "probe-link"));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return false;
    throw error;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

const canCreateSymlinks = probeSymlinkCreation();

async function createSymlinkedWorktree() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "meguribi-perm-link-"));
  tempDirs.push(base);
  const actual = path.join(base, "actual-worktree");
  await fsp.mkdir(actual);
  await fsp.writeFile(path.join(actual, "README.md"), "# fixture\n", "utf8");
  const link = path.join(base, "linked-worktree");
  await fsp.symlink(actual, link);
  return { base, actual, link };
}

function editParams(targetPath: string): RequestPermissionRequest {
  return {
    sessionId: "s-1",
    toolCall: {
      toolCallId: "r-1",
      name: "write file",
      title: "edit file",
      kind: "edit",
      locations: [{ path: targetPath }],
    },
    options: [{ optionId: "allow", name: "allow once", kind: "allow_once" as const }],
  };
}

describe("normalizeAcpPermissionRequest with symlinked worktree paths", () => {
  it.skipIf(!canCreateSymlinks)("allows an existing file inside the worktree when the agent reports a realpath-resolved target", async () => {
    const { link } = await createSymlinkedWorktree();
    const agentReported = path.join(fs.realpathSync(link), "README.md");
    const request = normalizeAcpPermissionRequest(
      editParams(agentReported),
      { cwd: link, protectedPaths: [] },
    );
    expect(request.targetWithinWorktree).toBe(true);
  });

  it.skipIf(!canCreateSymlinks)("allows writing a new file inside the worktree when the parent is inside the worktree", async () => {
    const { link } = await createSymlinkedWorktree();
    const agentReported = path.join(fs.realpathSync(link), "new-file.txt");
    const request = normalizeAcpPermissionRequest(
      editParams(agentReported),
      { cwd: link, protectedPaths: [] },
    );
    expect(request.targetWithinWorktree).toBe(true);
  });

  it.skipIf(!canCreateSymlinks)("allows writing a new file in a not-yet-created nested directory inside the worktree", async () => {
    const { link } = await createSymlinkedWorktree();
    const agentReported = path.join(fs.realpathSync(link), "new-dir", "new-file.txt");
    const request = normalizeAcpPermissionRequest(
      editParams(agentReported),
      { cwd: link, protectedPaths: [] },
    );
    expect(request.targetWithinWorktree).toBe(true);
  });

  it.skipIf(!canCreateSymlinks)("still allows a relative path inside the symlinked worktree", async () => {
    const { link } = await createSymlinkedWorktree();
    const request = normalizeAcpPermissionRequest(
      editParams("README.md"),
      { cwd: link, protectedPaths: [] },
    );
    expect(request.targetWithinWorktree).toBe(true);
  });

  it.skipIf(!canCreateSymlinks)("rejects a target escaping the worktree through a symlink", async () => {
    const { base, actual, link } = await createSymlinkedWorktree();
    const outsideFile = path.join(base, "outside-secret.txt");
    await fsp.writeFile(outsideFile, "secret\n", "utf8");
    await fsp.symlink(outsideFile, path.join(actual, "escaped-link.txt"));
    const target = path.join(link, "escaped-link.txt");
    const request = normalizeAcpPermissionRequest(
      editParams(target),
      { cwd: link, protectedPaths: [] },
    );
    expect(request.targetWithinWorktree).toBe(false);
  });

  it.skipIf(!canCreateSymlinks)("rejects a new file written through a symlinked directory escaping the worktree", async () => {
    const { base, actual, link } = await createSymlinkedWorktree();
    const outsideDir = path.join(base, "outside-dir");
    await fsp.mkdir(outsideDir);
    await fsp.symlink(outsideDir, path.join(actual, "escaped-dir"));
    const target = path.join(link, "escaped-dir", "new-file.txt");
    const request = normalizeAcpPermissionRequest(
      editParams(target),
      { cwd: link, protectedPaths: [] },
    );
    expect(request.targetWithinWorktree).toBe(false);
  });

  it.skipIf(!canCreateSymlinks)("still flags protected paths inside a symlinked worktree", async () => {
    const { actual, link } = await createSymlinkedWorktree();
    await fsp.writeFile(path.join(actual, ".env.local"), "TOKEN=fixture\n", "utf8");
    const agentReported = path.join(fs.realpathSync(link), ".env.local");
    const request = normalizeAcpPermissionRequest(
      editParams(agentReported),
      { cwd: link, protectedPaths: [".env*"] },
    );
    expect(request.targetWithinWorktree).toBe(true);
    expect(request.protectedPath).toBe(true);
  });
});
