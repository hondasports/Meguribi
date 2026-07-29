import type {
  PermissionDecision,
  PermissionOperation,
  PermissionRequest,
  PermissionPolicyContext,
} from "@meguribi/core";
import { decidePermission } from "@meguribi/core";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { homedir } from "node:os";
import path from "node:path";
import { redactDiagnosticText } from "./redact.js";

export interface NormalizePermissionOptions {
  cwd: string;
  protectedPaths: readonly string[];
  rawArtifactRef?: string;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function protectedMatch(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.replaceAll("\\", "/");
    const value = relativePath.replaceAll("\\", "/");
    if (normalized.endsWith("/**")) return value === normalized.slice(0, -3) || value.startsWith(`${normalized.slice(0, -3)}/`);
    if (normalized.endsWith("*")) return value.startsWith(normalized.slice(0, -1));
    return value === normalized;
  });
}

function inferOperation(params: RequestPermissionRequest): PermissionOperation {
  const tool = `${params.toolCall.name ?? ""} ${params.toolCall.kind ?? ""} ${params.toolCall.title ?? ""}`.toLowerCase();
  if (/git|commit|push|branch|pull request|issue/.test(tool)) return "git_write";
  if (/secret|credential|token|password|\.env/.test(tool)) return "secret_access";
  if (/network|http|https|mcp|web|browser/.test(tool)) return "external_network";
  if (/write|edit|create|apply|patch/.test(tool)) return "file_write";
  if (/read|search|list|find|inspect/.test(tool)) return "file_read";
  if (/terminal|command|shell|execute|run/.test(tool)) return "command";
  return "unknown";
}

function rawCommand(params: RequestPermissionRequest): string | undefined {
  const rawInput = params.toolCall.rawInput;
  if (typeof rawInput === "string") return redactDiagnosticText(rawInput);
  if (rawInput && typeof rawInput === "object") return redactDiagnosticText(JSON.stringify(rawInput));
  return undefined;
}

function resolvePermissionPath(root: string, candidate: string): string {
  const expanded = candidate.startsWith("~")
    ? path.resolve(homedir(), candidate.slice(1).replace(/^[/\\]+/, ""))
    : path.resolve(root, candidate);
  if (!candidate.startsWith("~")) return expanded;

  const normalizedRoot = path.resolve(root);
  const expandedLower = expanded.toLowerCase();
  const rootLower = normalizedRoot.toLowerCase();
  const rootIndex = expandedLower.lastIndexOf(rootLower);
  if (rootIndex >= 0) {
    const suffix = expanded.slice(rootIndex + normalizedRoot.length).replace(/^[/\\]+/, "");
    return path.resolve(normalizedRoot, suffix);
  }
  return expanded;
}

function optionCommand(params: RequestPermissionRequest): string | undefined {
  for (const option of params.options) {
    const match = /allow `([^`]+)` commands/i.exec(option.name);
    if (match?.[1]) return redactDiagnosticText(match[1]);
  }
  return undefined;
}

export function normalizeAcpPermissionRequest(
  params: RequestPermissionRequest,
  options: NormalizePermissionOptions,
): PermissionRequest {
  const command = rawCommand(params) ?? optionCommand(params);
  const operation = command ? "command" : inferOperation(params);
  const rawLocations = params.toolCall.locations ?? [];
  const root = path.resolve(options.cwd);
  const paths = rawLocations.flatMap((location) => typeof location.path === "string" ? [location.path] : []);
  const absolutePaths = paths.map((candidate) => resolvePermissionPath(root, candidate));
  const targetWithinWorktree = absolutePaths.length === 0
    ? operation === "command"
    : absolutePaths.every((candidate) => within(root, candidate));
  const relativePaths = absolutePaths.map((candidate) => path.relative(root, candidate));
  const summary = redactDiagnosticText(params.toolCall.title ?? params.toolCall.name ?? command ?? operation);
  return {
    requestId: params.toolCall.toolCallId,
    sessionId: params.sessionId,
    operation,
    tool: redactDiagnosticText(params.toolCall.name ?? params.toolCall.kind ?? "unknown"),
    summary,
    ...(paths[0] ? { targetPath: redactDiagnosticText(paths[0]) } : {}),
    ...(command ? { command } : {}),
    targetWithinWorktree,
    protectedPath: relativePaths.some((candidate) => protectedMatch(candidate, options.protectedPaths)),
    destructive: /delete|remove|destroy|reset|drop|force/i.test(summary),
    network: operation === "external_network",
    rawArtifactRef: options.rawArtifactRef ?? `raw-events.jsonl#${params.toolCall.toolCallId}`,
  };
}

function selectedOption(options: readonly PermissionOption[]): PermissionOption | undefined {
  return options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind === "allow_always");
}

export function toAcpPermissionResponse(
  decision: PermissionDecision,
  options: readonly PermissionOption[],
): RequestPermissionResponse {
  if (decision.outcome === "approve") {
    const option = selectedOption(options);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

export interface PermissionDecisionRecord {
  requestId: string;
  sessionId: string;
  decision: PermissionDecision;
}

export interface PermissionMediator {
  decide(request: PermissionRequest): Promise<PermissionDecision>;
  endSession(sessionId: string): void;
  records(): readonly PermissionDecisionRecord[];
}

export function createPermissionMediator(
  context: PermissionPolicyContext,
  confirm?: (request: PermissionRequest) => Promise<boolean> | boolean,
  confirmationTimeoutMs = 30_000,
): PermissionMediator {
  const cache = new Map<string, PermissionDecisionRecord>();
  const closedSessions = new Set<string>();
  const confirmWithTimeout = async (request: PermissionRequest): Promise<boolean> => {
    if (!confirm) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(confirm(request)),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), confirmationTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    async decide(request) {
      const key = JSON.stringify([request.sessionId, request.requestId]);
      if (closedSessions.has(request.sessionId)) {
        const decision = { outcome: "deny" as const, reason: "session has ended" };
        cache.set(key, { requestId: request.requestId, sessionId: request.sessionId, decision });
        return decision;
      }
      const previous = cache.get(key);
      if (previous) return previous.decision;
      let decision = decidePermission(request, context);
      if (decision.outcome === "confirm") {
        let confirmed = false;
        try {
          confirmed = await confirmWithTimeout(request);
        } catch {
          confirmed = false;
        }
        decision = confirmed
          ? { outcome: "approve", reason: "human confirmation accepted", optionId: "allow-once" }
          : { outcome: "deny", reason: "human confirmation was not received" };
      }
      cache.set(key, { requestId: request.requestId, sessionId: request.sessionId, decision });
      return decision;
    },
    endSession(sessionId) {
      closedSessions.add(sessionId);
    },
    records() {
      return [...cache.values()];
    },
  };
}
