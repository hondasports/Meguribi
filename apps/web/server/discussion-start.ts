import type http from "node:http";
import type { EventEmitter } from "node:events";
import type { AgentProfile } from "@meguribi/core";
import { loadAgentsConfig } from "@meguribi/config";
import { redactDiagnosticText } from "@meguribi/adapters";
import { hasJsonContentType, hasTrustedLocalWriteHeaders } from "./discussion-actions.js";
import { MAX_CONSULTATION_PROMPT_LENGTH } from "../src/consultation-contract.js";

export interface DiscussionProfileCandidate {
  id: string;
  label: string;
}

export interface CliProcess {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  once(event: "error" | "exit", listener: (value: unknown) => void): unknown;
  kill(signal?: number | NodeJS.Signals): unknown;
}

export interface StartDiscussionCli {
  (args: readonly string[]): CliProcess;
}

export interface DiscussionStartOptions {
  repositoryPath: string;
  startCli: StartDiscussionCli;
  loadProfiles?: () => Promise<{
    profiles: readonly AgentProfile[];
    roles: { discussants: readonly string[] };
  }>;
  runIdTimeoutMs?: number;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PROMPT_LENGTH = MAX_CONSULTATION_PROMPT_LENGTH;
const MAX_TARGET_LENGTH = 300;
const RUN_ID_PATTERN = /(?:^|\n)Run ID:\s*([^\s]+)/;
const DEFAULT_RUN_ID_TIMEOUT_MS = 10_000;

function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(value)}\n`);
}

function labelFor(profile: AgentProfile): string {
  if (profile.kind === "claude-code") return "Claude Code";
  if (profile.kind === "codex") return "Codex CLI";
  if (profile.kind === "devin") return "Devin CLI";
  return "Cursor CLI";
}

async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error("Request body is too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function validateStartBody(
  body: unknown,
  allowedIds: ReadonlySet<string>,
):
  | {
      prompt: string;
      profileIds: string[];
      target?: string;
      workflow?: "discuss" | "discuss-to-pr";
    }
  | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Invalid request body" };
  }
  const input = body as {
    prompt?: unknown;
    profileIds?: unknown;
    target?: unknown;
    workflow?: unknown;
  };
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    return { error: "prompt is required" };
  }
  if (input.prompt.length > MAX_PROMPT_LENGTH) {
    return { error: `prompt must be at most ${String(MAX_PROMPT_LENGTH)} characters` };
  }
  if (!Array.isArray(input.profileIds) || input.profileIds.some((id) => typeof id !== "string")) {
    return { error: "profileIds must be an array of profile ids" };
  }
  const rawProfileIds = input.profileIds as string[];
  const profileIds = [...new Set(rawProfileIds)];
  if (
    profileIds.length !== rawProfileIds.length ||
    profileIds.length < 2 ||
    profileIds.length > 4
  ) {
    return { error: "profileIds must contain 2 to 4 unique profiles" };
  }
  const unknown = profileIds.filter((id) => !allowedIds.has(id));
  if (unknown.length > 0) {
    return { error: `profileIds must be configured ACP profiles: ${unknown.join(", ")}` };
  }
  if (
    input.workflow !== undefined &&
    input.workflow !== "discuss" &&
    input.workflow !== "discuss-to-pr"
  ) {
    return { error: "workflow must be discuss or discuss-to-pr" };
  }
  if (input.workflow === "discuss-to-pr" && input.target === undefined) {
    return { error: "discuss-to-pr requires target" };
  }
  if (input.target !== undefined) {
    if (
      typeof input.target !== "string" ||
      input.target.trim().length === 0 ||
      input.target.length > MAX_TARGET_LENGTH ||
      input.target.includes("\0")
    ) {
      return { error: "target must be a non-empty issue target" };
    }
    const result: {
      prompt: string;
      profileIds: string[];
      target: string;
      workflow?: "discuss" | "discuss-to-pr";
    } = {
      prompt: input.prompt,
      profileIds,
      target: input.target.trim(),
    };
    if (input.workflow !== undefined) result.workflow = input.workflow;
    return result;
  }
  const result: { prompt: string; profileIds: string[]; workflow?: "discuss" | "discuss-to-pr" } = {
    prompt: input.prompt,
    profileIds,
  };
  if (input.workflow !== undefined) result.workflow = input.workflow;
  return result;
}

function cliArgs(
  input: {
    prompt: string;
    profileIds: string[];
    target?: string;
    workflow?: "discuss" | "discuss-to-pr";
  },
  repositoryPath: string,
): string[] {
  const discussants = input.profileIds.join(",");
  if (input.target !== undefined && input.workflow === "discuss-to-pr") {
    return [
      "workflow",
      "run",
      "discuss-to-pr",
      input.target,
      "--repo-path",
      repositoryPath,
      "--request",
      input.prompt,
      "--discussants",
      discussants,
      "--non-interactive",
    ];
  }
  const args = ["discuss"];
  if (input.target !== undefined) {
    args.push(input.target);
    args.push("--request", input.prompt);
  } else {
    args.push("--prompt", input.prompt);
  }
  args.push("--repo-path", repositoryPath, "--discussants", discussants, "--non-interactive");
  return args;
}

function terminateCliProcess(child: CliProcess): void {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // プロセスグループが既に無い場合は child への送信へフォールバックする。
    }
  }
  child.kill("SIGTERM");
}

async function waitForRunId(child: CliProcess, timeoutMs: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateCliProcess(child);
      reject(new Error("CLI did not report a persistent Run ID within the time limit"));
    }, timeoutMs);
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(RUN_ID_PATTERN);
      if (match?.[1] !== undefined && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      fail(error instanceof Error ? error.message : String(error));
    });
    child.once("exit", (code) => {
      const detail = redactDiagnosticText((stderr || stdout).trim());
      fail(
        `CLI exited before reporting a persistent Run ID (exit ${String(code)})` +
          (detail.length > 0 ? `: ${detail}` : ""),
      );
    });
  });
}

export function createDiscussionStartApi(options: DiscussionStartOptions): {
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
} {
  const loadProfiles =
    options.loadProfiles ??
    (() =>
      loadAgentsConfig({ repositoryPath: options.repositoryPath, cli: {}, nonInteractive: true }));
  const timeoutMs = options.runIdTimeoutMs ?? DEFAULT_RUN_ID_TIMEOUT_MS;

  async function candidates(): Promise<{
    profiles: DiscussionProfileCandidate[];
    defaultProfileIds: string[];
  }> {
    const config = await loadProfiles();
    const acp = config.profiles.filter((profile) => profile.transport === "acp");
    const allowed = new Set(acp.map((profile) => profile.id));
    return {
      profiles: acp.map((profile) => ({ id: profile.id, label: labelFor(profile) })),
      defaultProfileIds: config.roles.discussants.filter((id) => allowed.has(id)),
    };
  }

  return {
    async handle(req, res) {
      const path = (req.url ?? "").split("?", 1)[0];
      if (path === "/api/discussion/profiles") {
        if (req.method !== "GET") {
          writeJson(res, 405, { error: "Method not allowed" });
          return true;
        }
        try {
          writeJson(res, 200, await candidates());
        } catch (error) {
          writeJson(res, 500, {
            error: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
          });
        }
        return true;
      }
      if (path !== "/api/discussions") return false;
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      if (!hasTrustedLocalWriteHeaders(req)) {
        writeJson(res, 403, { error: "Forbidden local write request" });
        return true;
      }
      if (!hasJsonContentType(req)) {
        writeJson(res, 415, { error: "Discussion start requires application/json" });
        return true;
      }
      let body: unknown;
      try {
        body = await parseJsonBody(req);
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return true;
      }

      let available;
      try {
        available = await candidates();
      } catch (error) {
        writeJson(res, 500, {
          error: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
        });
        return true;
      }
      const validated = validateStartBody(
        body,
        new Set(available.profiles.map((profile) => profile.id)),
      );
      if ("error" in validated) {
        writeJson(res, 400, { error: validated.error });
        return true;
      }

      let child: CliProcess;
      try {
        child = options.startCli(cliArgs(validated, options.repositoryPath));
      } catch (error) {
        writeJson(res, 502, {
          error: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
        });
        return true;
      }
      try {
        const runId = await waitForRunId(child, timeoutMs);
        writeJson(res, 202, { runId });
      } catch (error) {
        writeJson(res, 502, {
          error: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
        });
      }
      return true;
    },
  };
}
