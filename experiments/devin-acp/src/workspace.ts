import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./git.js";
import type { OutsideSnapshot } from "./types.js";

export interface Fixture {
  root: string;
  normalCheckout: string;
  worktree: string;
  outside: string;
  cleanup: () => Promise<void>;
}

export async function createFixture(prefix = path.join(os.tmpdir(), "meguribi-devin-acp-")): Promise<Fixture> {
  const root = await fs.mkdtemp(prefix);
  const normalCheckout = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  const outside = path.join(root, "outside");
  await fs.mkdir(normalCheckout);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(normalCheckout, "README.md"), "# ACP fixture\n", "utf8");
  await runCommand("git", ["init", "-b", "main"], normalCheckout);
  await runCommand("git", ["-c", "user.name=Meguribi Fixture", "-c", "user.email=fixture@example.invalid", "add", "README.md"], normalCheckout);
  await runCommand("git", ["-c", "user.name=Meguribi Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], normalCheckout);
  await runCommand("git", ["worktree", "add", "-b", "issue-3-fixture", worktree], normalCheckout);
  return {
    root,
    normalCheckout,
    worktree,
    outside,
    cleanup: async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await runCommand("git", ["worktree", "remove", "--force", worktree], normalCheckout);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

export async function snapshotDirectory(directory: string): Promise<OutsideSnapshot> {
  const result: OutsideSnapshot = {};
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(directory, fullPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const digest = crypto.createHash("sha256").update(await fs.readFile(fullPath)).digest("hex");
        result[relative] = digest;
      }
    }
  };
  await walk(directory);
  return result;
}

export function diffSnapshots(before: OutsideSnapshot, after: OutsideSnapshot): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}
