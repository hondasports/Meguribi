import type { AgentEvent } from "./agent-event.js";
import type { AgentPrompt } from "./agent-prompt.js";
import type { InheritedMcpPolicy } from "./inherited-mcp-policy.js";

/**
 * 接続できるエージェントの種別。
 * kind ごとの起動方法は adapters 側に閉じ込める。
 */
export type AgentKind = "claude-code" | "codex" | "devin" | "cursor";

/**
 * エージェントへの接続方式。
 * `acp` は ACP サーバーとして単体起動、`sdk` はベンダー SDK 経由。
 */
export type AgentTransport = "acp" | "sdk";

/**
 * エージェントに割り当て可能な役割。
 */
export type AgentRole =
  | "discussant"
  | "summarizer"
  | "specifier"
  | "planner"
  | "implementer"
  | "reviewer";

/**
 * 接続可能なエージェントの定義。
 * `executable` は transport `acp` で単体起動するときの実行ファイル。
 */
export interface AgentProfile {
  id: string;
  kind: AgentKind;
  transport: AgentTransport;
  executable?: string;
  startupTimeoutMs: number;
  turnTimeoutMinutes: number;
  inheritedMcpPolicy: InheritedMcpPolicy;
}

/**
 * 役割ごとのプロファイル割り当て。
 * `implementer` は未指定のまま CLI / 設定で後から決められる。
 */
export interface RoleAssignments {
  discussants: readonly string[];
  summarizer?: string;
  specifier?: string;
  planner: string;
  implementer?: string;
  reviewer: string;
  allowSameImplementerReviewer: boolean;
}

export type RoleSessionMode = "read-only" | "write";

export interface AgentTurnResult {
  sessionId: string;
  text: string;
  stopReason?: string;
  events: readonly AgentEvent[];
}

export interface RoleSession {
  readonly sessionId: string;
  send(prompt: AgentPrompt): Promise<AgentTurnResult>;
  close(): Promise<void>;
}

export interface OpenRoleSessionInput {
  cwd: string;
  mode: RoleSessionMode;
  role: AgentRole;
  artifactRoot: string;
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface RoleAgent {
  readonly profileId: string;
  readonly kind: AgentKind;
  openSession(input: OpenRoleSessionInput): Promise<RoleSession>;
}

export type RoleAssignmentErrorCode =
  | "unknown_profile"
  | "same_implementer_reviewer"
  | "transport_unsupported"
  | "duplicate_discussant"
  | "invalid_discussants";

export class RoleAssignmentError extends Error {
  readonly code: RoleAssignmentErrorCode;
  readonly nextAction: string;

  constructor(code: RoleAssignmentErrorCode, message: string, nextAction: string) {
    super(message);
    this.name = "RoleAssignmentError";
    this.code = code;
    this.nextAction = nextAction;
  }
}

function assignedProfileIds(assignments: RoleAssignments): { role: AgentRole; id: string }[] {
  const entries: { role: AgentRole; id: string }[] = assignments.discussants.map((id) => ({
    role: "discussant",
    id,
  }));
  if (assignments.summarizer !== undefined) {
    entries.push({ role: "summarizer", id: assignments.summarizer });
  }
  if (assignments.specifier !== undefined) {
    entries.push({ role: "specifier", id: assignments.specifier });
  }
  entries.push({ role: "planner", id: assignments.planner });
  if (assignments.implementer !== undefined) {
    entries.push({ role: "implementer", id: assignments.implementer });
  }
  entries.push({ role: "reviewer", id: assignments.reviewer });
  return entries;
}

/**
 * 役割割り当てをプロファイル一覧に照らして検証する。
 * implementer と reviewer の同一プロファイルは既定で禁止し、
 * implementer には書き込み可能な transport `acp` のプロファイルを要求する。
 */
export function validateRoleAssignments(
  assignments: RoleAssignments,
  profiles: readonly AgentProfile[],
): void {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  for (const { role, id } of assignedProfileIds(assignments)) {
    if (!byId.has(id)) {
      throw new RoleAssignmentError(
        "unknown_profile",
        `roles.${role} references unknown profile: ${id}`,
        `\`.meguribi.yml\` の \`roles.${role}\` を既存のプロファイル ID に直してください`,
      );
    }
  }

  const seenDiscussants = new Set<string>();
  for (const id of assignments.discussants) {
    if (seenDiscussants.has(id)) {
      throw new RoleAssignmentError(
        "duplicate_discussant",
        `roles.discussants contains duplicate profile: ${id}`,
        "`discussants` の重複を除いてください",
      );
    }
    seenDiscussants.add(id);
  }

  if (
    assignments.implementer !== undefined &&
    assignments.implementer === assignments.reviewer &&
    !assignments.allowSameImplementerReviewer
  ) {
    throw new RoleAssignmentError(
      "same_implementer_reviewer",
      `implementer and reviewer must differ: ${assignments.implementer}`,
      "`allowSameImplementerReviewer: true` を明示してください",
    );
  }

  if (assignments.implementer !== undefined) {
    const implementer = byId.get(assignments.implementer);
    if (implementer && implementer.transport !== "acp") {
      throw new RoleAssignmentError(
        "transport_unsupported",
        `implementer requires an acp-transport profile: ${implementer.id} uses ${implementer.transport}`,
        `\`agents.${implementer.id}.transport: acp\` のプロファイルを選んでください`,
      );
    }
  }
}

const DISPLAY_NAMES: Record<AgentKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  devin: "Devin",
  cursor: "Cursor",
};

export function agentDisplayName(kind: AgentKind): string {
  return DISPLAY_NAMES[kind];
}
