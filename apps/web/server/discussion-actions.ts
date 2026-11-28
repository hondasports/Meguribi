import type http from "node:http";
import { redactDiagnosticText, type FileSystemRunStore } from "@meguribi/adapters";
import { isValidRunId, readDiscussionDetail, type DiscussionDetail } from "./run-store-api.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliRunner {
  run(args: readonly string[]): Promise<CliResult>;
}

export interface DiscussionActionsOptions {
  runStore: FileSystemRunStore;
  cli: CliRunner;
}

type DiscussionAction = "say" | "approve" | "reject";

interface DiscussionActionRoute {
  action: DiscussionAction;
  runId: string;
}

const ACTIONS_PATH = "/api/run-store/runs";
const MAX_BODY_BYTES = 64 * 1024;
const SAY_MAX_LENGTH = 4_000;
const REJECT_REASON_MAX_LENGTH = 2_000;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const REDO_START_TIMEOUT_MS = 5_000;
const REDO_START_POLL_MS = 20;

function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(value)}\n`);
}

function parseRoute(rawUrl: string | undefined): DiscussionActionRoute | null {
  if (rawUrl === undefined) return null;
  const rawPath = rawUrl.split("?", 1)[0] ?? "";
  const prefix = `${ACTIONS_PATH}/`;
  if (!rawPath.startsWith(prefix)) return null;
  const segments = rawPath.slice(prefix.length).split("/");
  if (segments.length !== 2) return null;
  const action = segments[1];
  if (action !== "say" && action !== "approve" && action !== "reject") return null;
  let runId: string;
  try {
    runId = decodeURIComponent(segments[0] ?? "");
  } catch {
    runId = "";
  }
  return { action, runId };
}

function hostnameFromHostHeader(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host === "::1") return host;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(1, end) : host;
  }
  const portIndex = host.lastIndexOf(":");
  return portIndex >= 0 ? host.slice(0, portIndex) : host;
}

function isLoopbackHostHeader(hostHeader: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostnameFromHostHeader(hostHeader));
}

export function hasTrustedLocalWriteHeaders(req: http.IncomingMessage): boolean {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || !isLoopbackHostHeader(hostHeader)) {
    return false;
  }
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== "string" || origin === "null") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return (
    isLoopbackHostHeader(url.host) && url.host.toLowerCase() === hostHeader.trim().toLowerCase()
  );
}

async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
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

export function hasJsonContentType(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string") return false;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

type ValidatedBody =
  | { action: "say"; message: string }
  | { action: "approve"; comment?: string }
  | { action: "reject"; reason: string; redo: boolean };

function validateBody(action: DiscussionAction, body: unknown): ValidatedBody | null {
  const record = asRecord(body);
  if (record === null) return null;
  if (action === "say") {
    if (!validText(record.message, SAY_MAX_LENGTH)) return null;
    return { action, message: record.message };
  }
  if (action === "approve") {
    if (record.comment !== undefined && typeof record.comment !== "string") return null;
    return {
      action,
      ...(record.comment === undefined ? {} : { comment: record.comment }),
    };
  }
  if (!validText(record.reason, REJECT_REASON_MAX_LENGTH)) return null;
  if (typeof record.redo !== "boolean") return null;
  return { action, reason: record.reason, redo: record.redo };
}

function cliArgs(route: DiscussionActionRoute, body: ValidatedBody): string[] {
  if (body.action === "say") return ["say", route.runId, body.message];
  if (body.action === "approve") {
    return [
      "approve",
      route.runId,
      ...(body.comment === undefined ? [] : ["--comment", body.comment]),
    ];
  }
  return ["reject", route.runId, "--reason", body.reason, ...(body.redo ? ["--redo"] : [])];
}

function conflictFor(action: DiscussionAction, detail: DiscussionDetail): string | null {
  if (action === "say" && !detail.canInterject) {
    return "Run is not accepting discussion messages";
  }
  if ((action === "approve" || action === "reject") && !detail.canDecide) {
    return "Run is not awaiting an approval decision";
  }
  return null;
}

async function writeCliResult(res: http.ServerResponse, result: CliResult): Promise<void> {
  if (result.exitCode === 0) {
    writeJson(res, 200, { ok: true, stdout: redactDiagnosticText(result.stdout) });
    return;
  }
  writeJson(res, 422, { ok: false, stderr: redactDiagnosticText(result.stderr) });
}

async function waitForRedoStart(
  runStore: FileSystemRunStore,
  runId: string,
  _previousUpdatedAt: string,
): Promise<boolean> {
  const deadline = Date.now() + REDO_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await runStore.load(runId);
    if (state !== null && state.status !== "awaiting_human") {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, REDO_START_POLL_MS));
  }
  return false;
}

export function createDiscussionActions(options: DiscussionActionsOptions): {
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
} {
  const redoPending = new Set<string>();
  return {
    async handle(req, res) {
      const route = parseRoute(req.url);
      if (route === null) return false;
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      if (!hasTrustedLocalWriteHeaders(req)) {
        writeJson(res, 403, { error: "Forbidden local write request" });
        return true;
      }
      if (!isValidRunId(route.runId)) {
        writeJson(res, 400, { error: "Invalid run id" });
        return true;
      }
      if (!hasJsonContentType(req)) {
        writeJson(res, 415, { error: "Discussion actions require application/json" });
        return true;
      }

      let body: unknown;
      try {
        body = await parseJsonBody(req);
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return true;
      }
      const validated = validateBody(route.action, body);
      if (validated === null) {
        writeJson(res, 400, { error: "Invalid request body" });
        return true;
      }

      const state = await options.runStore.load(route.runId);
      if (state === null) {
        writeJson(res, 404, { error: "Run not found" });
        return true;
      }
      const detail = await readDiscussionDetail(options.runStore, route.runId);
      if (detail === null) {
        writeJson(res, 409, { error: "Run is not a discussion run" });
        return true;
      }
      const conflict = conflictFor(route.action, detail);
      if (conflict !== null) {
        writeJson(res, 409, { error: conflict });
        return true;
      }
      if (
        (route.action === "approve" || route.action === "reject") &&
        redoPending.has(route.runId)
      ) {
        writeJson(res, 409, { error: "Discussion redo is starting" });
        return true;
      }

      const args = cliArgs(route, validated);
      if (validated.action === "reject" && validated.redo) {
        let cliPromise: Promise<CliResult>;
        try {
          redoPending.add(route.runId);
          cliPromise = options.cli.run(args);
        } catch (error) {
          redoPending.delete(route.runId);
          writeJson(res, 502, {
            ok: false,
            stderr: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
          });
          return true;
        }
        void cliPromise.catch(() => undefined).finally(() => redoPending.delete(route.runId));
        const started = await waitForRedoStart(options.runStore, route.runId, state.updatedAt);
        if (started) {
          redoPending.delete(route.runId);
          writeJson(res, 202, { ok: true, started: true });
        } else {
          writeJson(res, 504, {
            ok: false,
            stderr: "Discussion redo did not start within the time limit",
          });
        }
        return true;
      }

      try {
        const result = await options.cli.run(args);
        await writeCliResult(res, result);
      } catch (error) {
        writeJson(res, 502, {
          ok: false,
          stderr: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
        });
      }
      return true;
    },
  };
}
