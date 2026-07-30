import fs from "node:fs/promises";
import path from "node:path";
import type { HypothesisArtifact, HypothesisArtifactStore } from "@meguribi/core";

export interface FileSystemHypothesisArtifactStoreOptions { rootDir: string }

export class FileSystemHypothesisArtifactStore implements HypothesisArtifactStore {
  private readonly rootDir: string;

  constructor(options: FileSystemHypothesisArtifactStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
  }

  async save(input: { repository: string; issueNumber: number; artifact: HypothesisArtifact }): Promise<string> {
    const parts = input.repository.split("/");
    if (parts.length !== 2 || parts.some((part) => !isSafeSegment(part))) throw new Error(`Invalid repository identity: ${input.repository}`);
    if (!Number.isInteger(input.issueNumber) || input.issueNumber < 1) throw new Error(`Invalid Issue number: ${String(input.issueNumber)}`);
    const root = path.join(this.rootDir, "hypotheses");
    const directory = path.resolve(root, parts[0]!, parts[1]!, `issue-${String(input.issueNumber)}`);
    assertPathInside(root, directory);
    const artifactPath = path.join(directory, "hypothesis.json");
    await atomicWriteFile(artifactPath, `${JSON.stringify(input.artifact, null, 2)}\n`);
    return artifactPath;
  }
}

function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("\\") && !value.includes("\0");
}

function assertPathInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Path escapes HypothesisArtifactStore root: ${candidate}`);
}

async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    try {
      await fs.rename(tempPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
      await fs.rm(filePath, { force: true });
      await fs.rename(tempPath, filePath);
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
