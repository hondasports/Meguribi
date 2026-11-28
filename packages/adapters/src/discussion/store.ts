import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  DiscussionConclusion,
  DiscussionStorePort,
  DiscussionTurn,
} from "@meguribi/core";
import { DiscussionConclusionSchema } from "@meguribi/schemas";
import * as v from "valibot";
import { redactDiagnosticText, redactJsonValue } from "../acp/redact.js";
import type { FileSystemRunStore } from "../run-store/filesystem-run-store.js";

const HUMAN_MESSAGE_MAX_LENGTH = 4_000;

export interface FileSystemDiscussionStoreOptions {
  runStore: FileSystemRunStore;
  runId: string;
  now?: () => Date;
}

/**
 * Run ディレクトリ配下に議論の transcript / conclusion / inbox を保存する。
 * 保存する文字列はすべて redaction を通す。
 */
export class FileSystemDiscussionStore implements DiscussionStorePort {
  private readonly runStore: FileSystemRunStore;
  private readonly runId: string;
  private readonly now: () => Date;

  constructor(options: FileSystemDiscussionStoreOptions) {
    this.runStore = options.runStore;
    this.runId = options.runId;
    this.now = options.now ?? (() => new Date());
  }

  async appendTurn(turn: DiscussionTurn): Promise<void> {
    const runDir = await this.requireRunDir();
    const discussionDir = path.join(runDir, "discussion");
    await fs.mkdir(discussionDir, { recursive: true });
    const redacted = redactJsonValue(turn) as DiscussionTurn;
    await fs.appendFile(
      path.join(discussionDir, "transcript.jsonl"),
      `${JSON.stringify(redacted)}\n`,
      "utf8",
    );
  }

  async readTurns(): Promise<DiscussionTurn[]> {
    const runDir = await this.requireRunDir();
    let contents: string;
    try {
      contents = await fs.readFile(path.join(runDir, "discussion", "transcript.jsonl"), "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const turns: DiscussionTurn[] = [];
    const lines = contents.split("\n").filter((line) => line.length > 0);
    for (const [index, line] of lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Invalid discussion transcript JSONL at line ${String(index + 1)}`);
      }
      if (!isDiscussionTurn(parsed)) {
        throw new Error(`Invalid discussion transcript turn at line ${String(index + 1)}`);
      }
      turns.push(parsed);
    }
    return turns;
  }

  async readHumanMessages(): Promise<{ message: string; at: string }[]> {
    const runDir = await this.requireRunDir();
    const inboxDir = path.join(runDir, "inbox");
    let entries: string[];
    try {
      entries = await fs.readdir(inboxDir);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const messages: { message: string; at: string }[] = [];
    const jsonEntries = entries.filter((entry) => entry.endsWith(".json")).sort();
    for (const entry of jsonEntries) {
      const sourcePath = path.join(inboxDir, entry);
      const processedDir = path.join(inboxDir, "processed");
      await fs.mkdir(processedDir, { recursive: true });
      const processedPath = path.join(processedDir, entry);

      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(sourcePath, "utf8"));
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          continue;
        }
        await moveToProcessed(sourcePath, processedPath);
        continue;
      }

      if (isHumanMessageFile(parsed)) {
        messages.push({
          message: normalizeHumanMessage(parsed.message),
          at: parsed.at,
        });
      }
      await moveToProcessed(sourcePath, processedPath);
    }
    return messages;
  }

  async writeHumanMessage(message: string): Promise<string> {
    const runDir = await this.requireRunDir();
    const inboxDir = path.join(runDir, "inbox");
    await fs.mkdir(inboxDir, { recursive: true });
    const at = this.now().toISOString();
    const safeTimestamp = at.replace(/[:.]/g, "-");
    const fileName = `${safeTimestamp}-${randomBytes(4).toString("hex")}.json`;
    const filePath = path.join(inboxDir, fileName);
    const payload = {
      message: normalizeHumanMessage(message),
      at,
    };
    await atomicWriteFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    return filePath;
  }

  async saveConclusion(conclusion: DiscussionConclusion): Promise<void> {
    const runDir = await this.requireRunDir();
    const conclusionPath = path.join(runDir, "discussion", "conclusion.json");
    const redacted = redactJsonValue(conclusion) as DiscussionConclusion;
    await atomicWriteFile(conclusionPath, `${JSON.stringify(redacted, null, 2)}\n`);
  }

  async readConclusion(): Promise<DiscussionConclusion | null> {
    const runDir = await this.requireRunDir();
    let raw: string;
    try {
      raw = await fs.readFile(path.join(runDir, "discussion", "conclusion.json"), "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return v.parse(DiscussionConclusionSchema, JSON.parse(raw));
  }

  private async requireRunDir(): Promise<string> {
    const runDir = await this.runStore.runDirectory(this.runId);
    if (runDir === null) {
      throw new Error(`Run not found: ${this.runId}`);
    }
    return runDir;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDiscussionTurn(value: unknown): value is DiscussionTurn {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.turnId !== "string" ||
    typeof value.speaker !== "string" ||
    typeof value.speakerLabel !== "string" ||
    typeof value.malformed !== "boolean" ||
    typeof value.at !== "string" ||
    !isRecord(value.envelope)
  ) {
    return false;
  }
  const envelope = value.envelope;
  return (
    typeof envelope.message === "string" &&
    isStringArray(envelope.replyTo) &&
    isStringArray(envelope.addressTo) &&
    Array.isArray(envelope.positions) &&
    envelope.positions.every(
      (position) =>
        isRecord(position) &&
        typeof position.issue === "string" &&
        typeof position.stance === "string",
    ) &&
    isStringArray(envelope.newIssues) &&
    typeof envelope.done === "boolean"
  );
}

function isHumanMessageFile(value: unknown): value is { message: string; at: string } {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    typeof value.at === "string"
  );
}

function normalizeHumanMessage(message: string): string {
  const redacted = redactDiagnosticText(message);
  if (redacted.length <= HUMAN_MESSAGE_MAX_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, HUMAN_MESSAGE_MAX_LENGTH - 1)}…`;
}

async function moveToProcessed(sourcePath: string, processedPath: string): Promise<void> {
  try {
    await fs.rename(sourcePath, processedPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    try {
      await fs.rename(tempPath, filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EEXIST" || err.code === "EPERM" || err.code === "EACCES") {
        await fs.rm(filePath, { force: true });
        await fs.rename(tempPath, filePath);
      } else {
        throw error;
      }
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
