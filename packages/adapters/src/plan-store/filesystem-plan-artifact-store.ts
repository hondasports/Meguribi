import fs from "node:fs/promises";
import path from "node:path";
import type { PlanArtifact, PlanArtifactStore } from "@meguribi/core";

export interface FileSystemPlanArtifactStoreOptions {
  rootDir: string;
}

export class FileSystemPlanArtifactStore implements PlanArtifactStore {
  private readonly rootDir: string;

  constructor(options: FileSystemPlanArtifactStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
  }

  async save(input: {
    repository: string;
    issueNumber: number;
    plan: PlanArtifact;
  }): Promise<string> {
    const artifactPath = path.join(
      this.issueDir(input.repository, input.issueNumber),
      "plan.json",
    );
    await atomicWriteFile(artifactPath, `${JSON.stringify(input.plan, null, 2)}\n`);
    return artifactPath;
  }

  private issueDir(repository: string, issueNumber: number): string {
    const parts = repository.split("/");
    if (parts.length !== 2 || parts.some((part) => !isSafeSegment(part))) {
      throw new Error(`Invalid repository identity: ${repository}`);
    }
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      throw new Error(`Invalid Issue number: ${String(issueNumber)}`);
    }
    const root = path.join(this.rootDir, "plans");
    const issueDir = path.resolve(root, parts[0]!, parts[1]!, `issue-${String(issueNumber)}`);
    assertPathInside(root, issueDir);
    return issueDir;
  }
}

function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("\\") && !value.includes("\0");
}

function assertPathInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes PlanArtifactStore root: ${candidate}`);
  }
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
