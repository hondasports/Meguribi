import type * as acp from "@agentclientprotocol/sdk";
import type { AuthenticationStatus } from "./diagnose.js";
import type { CONFIG_SOURCE_ORDER, ConfigSource } from "./isolation.js";
import type { McpObservation, McpPolicy } from "./mcp.js";

export type ProbeStatus = "completed" | "cancelled" | "timed_out" | "failed";

export type AgentEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "message.delta"; sessionId: string; text: string }
  | { type: "tool.started"; sessionId: string; tool: string; toolCallId: string; summary?: string }
  | { type: "tool.completed"; sessionId: string; tool: string; toolCallId: string; status: string }
  | { type: "file.changed"; sessionId: string; path: string }
  | { type: "approval.required"; sessionId: string; requestId: string; summary: string; decision: "allow" | "deny" }
  | { type: "turn.completed"; sessionId: string; stopReason: string }
  | { type: "session.failed"; message: string };

export type OutsideSnapshot = Record<string, string>;

export interface ProbeOptions {
  executable: string;
  args: string[];
  cliVersion: string;
  cwd: string;
  prompt: string;
  artifactDir: string;
  timeoutMs: number;
  cancelAfterMs?: number;
  allowedWritePaths: string[];
  outsideRoots: string[];
  env?: NodeJS.ProcessEnv;
  shutdownGraceMs?: number;
  mcpPolicy?: McpPolicy;
  allowedMcpNames?: string[];
  configSources?: ConfigSource[];
  isolationStatus?: "isolated" | "blocked" | "unknown";
  authenticationStatus?: AuthenticationStatus;
  rootHelp?: string;
  acpHelp?: string;
  mcpStartupGraceMs?: number;
}

export interface ProbeResult {
  schemaVersion: 1;
  artifactType: "devin-acp-probe";
  command: { executable: string; args: string[] };
  cliVersion: string;
  cwd: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  sdkVersion: string;
  status: ProbeStatus;
  protocolVersion?: number;
  agentInfo?: acp.Implementation | null;
  sessionId?: string;
  stopReason?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  changedFiles: string[];
  outsideChanges: string[];
  permissionRequests: Array<{
    requestId: string;
    summary: string;
    decision: "allow" | "deny";
  }>;
  mcp: {
    policy: McpPolicy;
    allowedNames: string[];
    observations: McpObservation[];
    unexpected: McpObservation[];
    action: "none" | "blocked-and-terminated";
    configSources: ConfigSource[];
    sourceOrder: typeof CONFIG_SOURCE_ORDER;
  };
  diagnosis: {
    isolation: "isolated" | "blocked" | "unknown";
    authentication: AuthenticationStatus;
    devinAcpCandidate: boolean;
    reason: string;
  };
  residualProcesses: boolean;
  error?: string;
  artifacts: {
    events: string;
    normalizedEvents: string;
    stderr: string;
    session: string;
    result: string;
  };
}
