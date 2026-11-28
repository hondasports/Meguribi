import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { EventEmitter } from "node:events";
import type { AgentProfile, DiscussionMcpPolicy, InheritedMcpPolicy } from "@meguribi/core";
import { resolveDiscussionMcpPolicy } from "@meguribi/core";
import { loadAgentsConfig, loadCursorConfig, loadDevinConfig } from "@meguribi/config";
import {
  diagnoseCursor,
  diagnoseDevin,
  MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
  MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
  redactDiagnosticText,
  resolveAcpServerExecutable,
  resolveAcpServerMainCli,
  resolvePlatformExecutable,
} from "@meguribi/adapters";
import { hasJsonContentType, hasTrustedLocalWriteHeaders } from "./discussion-actions.js";
import { MAX_CONSULTATION_PROMPT_LENGTH } from "../src/consultation-contract.js";

export interface DiscussionProfileCandidate {
  id: string;
  label: string;
  available: boolean;
  unavailableReason?: string;
}

export interface DiscussionProfileAvailability {
  available: boolean;
  unavailableReason?: string;
}

export interface DiagnoseDiscussionProfileInput {
  profile: AgentProfile;
  repositoryPath: string;
  nonInteractive: boolean;
  discussionMcpPolicy?: DiscussionMcpPolicy;
}

export type DiagnoseDiscussionProfile = (
  input: DiagnoseDiscussionProfileInput,
) => Promise<DiscussionProfileAvailability>;

export interface AvailabilityProbeResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export type AvailabilityProbeCommand = (input: {
  executable: string;
  executableArgs: readonly string[];
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}) => Promise<AvailabilityProbeResult>;

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
    roles: { discussants: readonly string[]; summarizer?: string };
  }>;
  diagnoseProfile?: DiagnoseDiscussionProfile;
  probeCommand?: AvailabilityProbeCommand;
  runIdTimeoutMs?: number;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PROMPT_LENGTH = MAX_CONSULTATION_PROMPT_LENGTH;
const MAX_TARGET_LENGTH = 300;
const RUN_ID_PATTERN = /(?:^|\n)Run ID:\s*([^\s]+)/;
const DEFAULT_RUN_ID_TIMEOUT_MS = 10_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const AUTH_PROBE_TIMEOUT_MS = 5_000;

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

function effectiveRunMcpPolicy(
  configured: readonly InheritedMcpPolicy[],
  discussionMcpPolicy: DiscussionMcpPolicy | undefined,
): DiscussionMcpPolicy | undefined {
  if (discussionMcpPolicy === undefined) return undefined;
  return resolveDiscussionMcpPolicy({ configured, discussionMcpPolicy });
}

function withInheritedMcpPolicy(
  profile: AgentProfile,
  inheritedMcpPolicy: InheritedMcpPolicy | undefined,
): AgentProfile {
  return inheritedMcpPolicy === undefined ? profile : { ...profile, inheritedMcpPolicy };
}

function availabilityFromDiagnosis(diagnosis: {
  runnable: boolean;
  errors: readonly { message: string; nextAction?: string }[];
}): DiscussionProfileAvailability {
  if (diagnosis.runnable) return { available: true };
  const first = diagnosis.errors[0];
  if (first === undefined) {
    return { available: false, unavailableReason: "ACP preflight diagnosis is not runnable" };
  }
  return {
    available: false,
    unavailableReason: redactDiagnosticText(
      first.nextAction === undefined ? first.message : `${first.message} ${first.nextAction}`,
    ),
  };
}

function safeAvailabilityError(error: unknown): DiscussionProfileAvailability {
  return {
    available: false,
    unavailableReason: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
  };
}

async function diagnoseDevinProfile(
  input: DiagnoseDiscussionProfileInput,
): Promise<DiscussionProfileAvailability> {
  const config = await loadDevinConfig({
    repositoryPath: input.repositoryPath,
    cli: {},
    nonInteractive: input.nonInteractive,
    ...(input.discussionMcpPolicy === undefined
      ? {}
      : { discussionMcpPolicy: input.discussionMcpPolicy }),
  });
  const effectiveMcpPolicy = effectiveRunMcpPolicy(
    [config.config.inheritedMcpPolicy, input.profile.inheritedMcpPolicy],
    input.discussionMcpPolicy,
  );
  const diagnosis = await diagnoseDevin({
    executable: config.config.executable,
    inheritedMcpPolicy: effectiveMcpPolicy ?? config.config.inheritedMcpPolicy,
    nonInteractive: input.nonInteractive,
    cwd: input.repositoryPath,
    probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
    minimumSupportedVersion: MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
  });
  return availabilityFromDiagnosis(diagnosis);
}

async function diagnoseCursorProfile(
  input: DiagnoseDiscussionProfileInput,
): Promise<DiscussionProfileAvailability> {
  const config = await loadCursorConfig({
    repositoryPath: input.repositoryPath,
    cli: {},
    nonInteractive: input.nonInteractive,
    ...(input.discussionMcpPolicy === undefined
      ? {}
      : { discussionMcpPolicy: input.discussionMcpPolicy }),
  });
  const effectiveMcpPolicy = effectiveRunMcpPolicy(
    [config.config.inheritedMcpPolicy, input.profile.inheritedMcpPolicy],
    input.discussionMcpPolicy,
  );
  const diagnosis = await diagnoseCursor({
    executable: config.config.executable,
    inheritedMcpPolicy: effectiveMcpPolicy ?? config.config.inheritedMcpPolicy,
    nonInteractive: input.nonInteractive,
    cwd: input.repositoryPath,
    probeTimeoutMs: Math.min(config.config.startupTimeoutMs, 10_000),
    minimumSupportedVersion: MINIMUM_SUPPORTED_CURSOR_CLI_VERSION,
  });
  return availabilityFromDiagnosis(diagnosis);
}

function appendLimitedText(current: string, chunk: Buffer, limit = 4096): string {
  if (current.length >= limit) return current;
  return current + chunk.toString("utf8").slice(0, limit - current.length);
}

export function probeAvailabilityCommand(input: {
  executable: string;
  executableArgs: readonly string[];
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}): Promise<AvailabilityProbeResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.executable, [...input.executableArgs, ...input.args], {
        cwd: input.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timers = new Set<NodeJS.Timeout>();
    const finish = (result: Omit<AvailabilityProbeResult, "stdout" | "stderr" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    const later = (fn: () => void, ms: number): void => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      timers.add(timer);
    };

    later(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
      }
      later(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }, 250);
    }, input.timeoutMs);
    later(() => {
      finish({
        ok: false,
        exitCode: null,
        error: `probe timed out after ${String(input.timeoutMs)}ms`,
      });
    }, input.timeoutMs + 750);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendLimitedText(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLimitedText(stderr, chunk);
    });
    child.once("error", (error) => {
      finish({ ok: false, exitCode: null, error: error.message });
    });
    child.once("close", (exitCode) => {
      finish({ ok: exitCode === 0 && !timedOut, exitCode });
    });
  });
}

function executableFileExists(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableAccessExists(
  executable: string,
  repositoryPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (/[\\/]/.test(executable) || path.isAbsolute(executable)) {
    return executableFileExists(path.resolve(repositoryPath, executable));
  }
  if (process.platform === "win32") {
    const resolved = resolvePlatformExecutable(executable, { env });
    return resolved !== executable && executableFileExists(resolved);
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  return pathValue
    .split(path.delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => executableFileExists(path.join(entry, executable)));
}

function mainCliDisplayName(kind: AgentProfile["kind"]): string {
  return kind === "codex" ? "Codex CLI" : "Claude Code";
}

function mainCliExecutableUnavailableReason(kind: AgentProfile["kind"]): string {
  return `${mainCliDisplayName(kind)} の実行ファイルを確認してください`;
}

function mainCliAuthenticationUnavailableReason(kind: AgentProfile["kind"]): string {
  return `${mainCliDisplayName(kind)} にログインしてください`;
}

function authenticatedByProbe(
  format: "claude-json" | "codex-text",
  result: AvailabilityProbeResult,
): boolean {
  if (!result.ok) return false;
  if (format === "codex-text") return true;
  try {
    const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}

async function diagnoseStandaloneAcpProfile(
  input: DiagnoseDiscussionProfileInput,
  probeCommand: AvailabilityProbeCommand,
): Promise<DiscussionProfileAvailability> {
  const effectiveMcpPolicy = effectiveRunMcpPolicy(
    [input.profile.inheritedMcpPolicy],
    input.discussionMcpPolicy,
  );
  const roleProfile = withInheritedMcpPolicy(input.profile, effectiveMcpPolicy);
  if (roleProfile.inheritedMcpPolicy === "warn" && input.nonInteractive) {
    return {
      available: false,
      unavailableReason:
        "inheritedMcpPolicy is warn, which is not allowed in non-interactive mode",
    };
  }
  const resolved = resolveAcpServerExecutable(input.profile);
  if (resolved.source !== "bundled") {
    if (!executableAccessExists(resolved.executable, input.repositoryPath)) {
      return {
        available: false,
        unavailableReason: `ACP executable is not executable or not on PATH: ${resolved.executable}`,
      };
    }
    return { available: true };
  }

  const cli = resolveAcpServerMainCli(input.profile);
  if (cli === undefined) {
    return {
      available: false,
      unavailableReason: `bundled ACP bridge or CLI foundation is incomplete for ${input.profile.id}`,
    };
  }
  const version = await probeCommand({
    executable: cli.executable,
    executableArgs: cli.executableArgs,
    args: cli.versionArgs,
    cwd: input.repositoryPath,
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
  });
  if (!version.ok) {
    return {
      available: false,
      unavailableReason: mainCliExecutableUnavailableReason(input.profile.kind),
    };
  }
  const auth = await probeCommand({
    executable: cli.executable,
    executableArgs: cli.executableArgs,
    args: cli.authArgs,
    cwd: input.repositoryPath,
    timeoutMs: AUTH_PROBE_TIMEOUT_MS,
  });
  if (!authenticatedByProbe(cli.authFormat, auth)) {
    return {
      available: false,
      unavailableReason: mainCliAuthenticationUnavailableReason(input.profile.kind),
    };
  }
  return { available: true };
}

async function diagnoseDiscussionProfile(
  input: DiagnoseDiscussionProfileInput,
  probeCommand: AvailabilityProbeCommand,
): Promise<DiscussionProfileAvailability> {
  try {
    if (input.profile.kind === "devin") return await diagnoseDevinProfile(input);
    if (input.profile.kind === "cursor") return await diagnoseCursorProfile(input);
    return await diagnoseStandaloneAcpProfile(input, probeCommand);
  } catch (error) {
    return safeAvailabilityError(error);
  }
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
      discussionMcpPolicy?: DiscussionMcpPolicy;
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
    discussionMcpPolicy?: unknown;
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
  // discussionMcpPolicy は省略時に許可しない（サーバー既定はフラグを渡さない）。
  // 指定時は "deny" | "allow" の文字列だけを受け付け、それ以外は fail-closed で拒否する。
  if (input.discussionMcpPolicy !== undefined) {
    if (input.discussionMcpPolicy !== "deny" && input.discussionMcpPolicy !== "allow") {
      return { error: "discussionMcpPolicy must be deny or allow" };
    }
    // P4/delivery の許可には広げない: discuss-to-pr との併用は拒否する。
    if (input.workflow === "discuss-to-pr") {
      return { error: "discussionMcpPolicy is only valid for discussions, not discuss-to-pr" };
    }
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
      discussionMcpPolicy?: "deny" | "allow";
    } = {
      prompt: input.prompt,
      profileIds,
      target: input.target.trim(),
    };
    if (input.workflow !== undefined) result.workflow = input.workflow;
    if (input.discussionMcpPolicy !== undefined) {
      result.discussionMcpPolicy = input.discussionMcpPolicy as "deny" | "allow";
    }
    return result;
  }
  const result: {
    prompt: string;
    profileIds: string[];
    workflow?: "discuss" | "discuss-to-pr";
    discussionMcpPolicy?: "deny" | "allow";
  } = {
    prompt: input.prompt,
    profileIds,
  };
  if (input.workflow !== undefined) result.workflow = input.workflow;
  if (input.discussionMcpPolicy !== undefined) {
    result.discussionMcpPolicy = input.discussionMcpPolicy as "deny" | "allow";
  }
  return result;
}

function cliArgs(
  input: {
    prompt: string;
    profileIds: string[];
    target?: string;
    workflow?: "discuss" | "discuss-to-pr";
    discussionMcpPolicy?: "deny" | "allow";
  },
  repositoryPath: string,
): string[] {
  const discussants = input.profileIds.join(",");
  if (input.target !== undefined && input.workflow === "discuss-to-pr") {
    // discuss-to-pr には discussion-mcp-policy を渡さない（delivery の許可に広げない）。
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
  // 明示指定されたときだけフラグを渡す。省略時は CLI の fail-closed 判定に委ねる。
  if (input.discussionMcpPolicy !== undefined) {
    args.push("--discussion-mcp-policy", input.discussionMcpPolicy);
  }
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

function discussionMcpPolicyQuery(url: string | undefined):
  | { discussionMcpPolicy: DiscussionMcpPolicy }
  | { error: string } {
  const parsed = new URL(url ?? "/", "http://localhost");
  const raw = parsed.searchParams.get("discussionMcpPolicy");
  if (raw === null) return { discussionMcpPolicy: "deny" };
  if (raw === "deny" || raw === "allow") return { discussionMcpPolicy: raw };
  return { error: "discussionMcpPolicy must be 'deny' or 'allow'" };
}

export function createDiscussionStartApi(options: DiscussionStartOptions): {
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
} {
  const loadProfiles =
    options.loadProfiles ??
    (() =>
      loadAgentsConfig({ repositoryPath: options.repositoryPath, cli: {}, nonInteractive: true }));
  const timeoutMs = options.runIdTimeoutMs ?? DEFAULT_RUN_ID_TIMEOUT_MS;

  const probeCommand = options.probeCommand ?? probeAvailabilityCommand;
  const diagnoseProfile =
    options.diagnoseProfile ?? ((input) => diagnoseDiscussionProfile(input, probeCommand));

  async function availabilityFor(
    profile: AgentProfile,
    discussionMcpPolicy: DiscussionMcpPolicy | undefined,
  ): Promise<DiscussionProfileAvailability> {
    try {
      return await diagnoseProfile({
        profile,
        repositoryPath: options.repositoryPath,
        nonInteractive: true,
        ...(discussionMcpPolicy === undefined ? {} : { discussionMcpPolicy }),
      });
    } catch (error) {
      return safeAvailabilityError(error);
    }
  }

  async function candidates(discussionMcpPolicy?: DiscussionMcpPolicy): Promise<{
    profiles: DiscussionProfileCandidate[];
    defaultProfileIds: string[];
  }> {
    const config = await loadProfiles();
    const acp = config.profiles.filter((profile) => profile.transport === "acp");
    const profiles = await Promise.all(
      acp.map(async (profile) => {
        const availability = await availabilityFor(profile, discussionMcpPolicy);
        return {
          id: profile.id,
          label: labelFor(profile),
          ...availability,
        };
      }),
    );
    const availableIds = new Set(
      profiles.filter((profile) => profile.available).map((profile) => profile.id),
    );
    return {
      profiles,
      defaultProfileIds: config.roles.discussants.filter((id) => availableIds.has(id)),
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
        const queryPolicy = discussionMcpPolicyQuery(req.url);
        if ("error" in queryPolicy) {
          writeJson(res, 400, { error: queryPolicy.error });
          return true;
        }
        try {
          writeJson(res, 200, await candidates(queryPolicy.discussionMcpPolicy));
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

      let config: Awaited<ReturnType<typeof loadProfiles>>;
      try {
        config = await loadProfiles();
      } catch (error) {
        writeJson(res, 500, {
          error: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
        });
        return true;
      }
      const acp = config.profiles.filter((profile) => profile.transport === "acp");
      const validated = validateStartBody(
        body,
        new Set(acp.map((profile) => profile.id)),
      );
      if ("error" in validated) {
        writeJson(res, 400, { error: validated.error });
        return true;
      }
      const requestedMcpPolicy = validated.discussionMcpPolicy;
      const selected = validated.profileIds
        .map((id) => acp.find((profile) => profile.id === id))
        .filter((profile): profile is AgentProfile => profile !== undefined);
      const diagnosed = await Promise.all(
        selected.map(async (profile) => ({
          profile,
          availability: await availabilityFor(profile, requestedMcpPolicy),
        })),
      );
      const unavailable = diagnosed.filter(({ availability }) => !availability.available);
      if (unavailable.length > 0) {
        writeJson(res, 409, {
          error: `profileIds are unavailable: ${unavailable
            .map(
              ({ profile, availability }) =>
                `${profile.id} (${availability.unavailableReason ?? "not runnable"})`,
            )
            .join(", ")}`,
        });
        return true;
      }

      const summarizerId = config.roles.summarizer ?? validated.profileIds[0];
      const alreadyDiagnosed = new Map(
        diagnosed.map(({ profile, availability }) => [profile.id, availability] as const),
      );
      const summarizerProfile = config.profiles.find((profile) => profile.id === summarizerId);
      let summarizerAvailability: DiscussionProfileAvailability;
      if (summarizerProfile === undefined) {
        summarizerAvailability = {
          available: false,
          unavailableReason: `summarizer profile is not configured: ${summarizerId}`,
        };
      } else if (summarizerProfile.transport !== "acp") {
        summarizerAvailability = {
          available: false,
          unavailableReason: `summarizer profile ${summarizerId} does not use acp transport`,
        };
      } else {
        summarizerAvailability =
          alreadyDiagnosed.get(summarizerId) ??
          (await availabilityFor(summarizerProfile, requestedMcpPolicy));
      }
      if (!summarizerAvailability.available) {
        writeJson(res, 409, {
          error: `summarizer profile ${summarizerId} is unavailable: ${
            summarizerAvailability.unavailableReason ?? "not runnable"
          }`,
        });
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
