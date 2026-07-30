import fs from "node:fs/promises";
import path from "node:path";
import type { RequirementArtifact, RequirementArtifactStore } from "@meguribi/core";
export interface FileSystemRequirementArtifactStoreOptions { rootDir: string }
export class FileSystemRequirementArtifactStore implements RequirementArtifactStore {
  private readonly rootDir: string;
  constructor(options: FileSystemRequirementArtifactStoreOptions) { this.rootDir = path.resolve(options.rootDir); }
  async save(input: { repository: string; sourceIssueNumber: number; artifact: RequirementArtifact }): Promise<string> {
    const parts = input.repository.split("/"); if (parts.length !== 2 || parts.some((part) => !safe(part))) throw new Error(`Invalid repository identity: ${input.repository}`);
    const root = path.join(this.rootDir, "requirements"); const directory = path.resolve(root, parts[0]!, parts[1]!, `from-issue-${String(input.sourceIssueNumber)}`); const relative = path.relative(path.resolve(root), directory); if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Path escapes RequirementArtifactStore root: ${directory}`);
    const file = path.join(directory, "requirements.json"); await fs.mkdir(directory, { recursive: true }); const temp = path.join(directory, `.requirements.json.${process.pid}.tmp`); try { await fs.writeFile(temp, `${JSON.stringify(input.artifact, null, 2)}\n`, "utf8"); try { await fs.rename(temp, file); } catch (error) { if (!isReplaceRace(error)) throw error; await fs.rm(file, { force: true }); await fs.rename(temp, file); } } catch (error) { await fs.rm(temp, { force: true }).catch(() => undefined); throw error; } return file;
  }
}
function safe(value: string): boolean { return value.length > 0 && value !== "." && value !== ".." && !value.includes("\\") && !value.includes("\0"); }
function isReplaceRace(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && ["EEXIST", "EPERM", "EACCES"].includes(String((error as { code?: unknown }).code)); }
