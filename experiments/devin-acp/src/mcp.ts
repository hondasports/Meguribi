import { redactText } from "./redaction.js";

export type McpTransport = "http" | "stdio" | "sse" | "unknown";
export type McpAction = "connecting" | "started" | "connected" | "unknown";
export type McpPolicy = "deny-all" | "allowlist";

export interface McpObservation {
  name: string;
  transport: McpTransport;
  target: string;
  action: McpAction;
}

export interface McpPolicyAssessment {
  allowed: boolean;
  unexpected: McpObservation[];
}

function transportFromLine(line: string): McpTransport {
  const match = line.match(/\b(http|https|stdio|sse)\b/i);
  if (!match) return "unknown";
  const value = match[1]?.toLowerCase() ?? "unknown";
  return value === "https" ? "http" : value as McpTransport;
}

function nameFromLine(line: string): string {
  const match = line.match(/mcp(?:\s+(?:server|stdio|http|sse))?\s+(?:server\s+)?([A-Za-z0-9_.-]+)/i);
  return match?.[1] ?? "unknown";
}

function targetFromLine(line: string, transport: McpTransport): string {
  if (transport === "http" || transport === "sse") {
    return redactText(line.match(/https?:\/\/[^\s)]+/i)?.[0] ?? "");
  }
  const command = redactText(line.match(/\bcommand[=:](.+)$/i)?.[1]?.trim() ?? "");
  return command === "" ? "" : `command=${command}`;
}

function actionFromLine(line: string): McpAction {
  if (/connect(?:ing|ed)?/i.test(line)) return /connected/i.test(line) ? "connected" : "connecting";
  if (/start(?:ed)?|spawn(?:ed)?/i.test(line)) return "started";
  return "unknown";
}

export function classifyMcpDiagnostics(text: string): McpObservation[] {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!/\bmcp\b|model context protocol/i.test(line) || !/connect|start|spawn|launch|mcp\s+(?:server|stdio|http|sse)/i.test(line)) return [];
    const transport = transportFromLine(line);
    return [{ name: nameFromLine(line), transport, target: targetFromLine(line, transport), action: actionFromLine(line) }];
  });
}

export function assessMcpPolicy(policy: McpPolicy, allowlist: string[], observations: McpObservation[]): McpPolicyAssessment {
  const unexpected = observations.filter((observation) => policy === "deny-all" || !allowlist.includes(observation.name));
  return { allowed: unexpected.length === 0, unexpected };
}
