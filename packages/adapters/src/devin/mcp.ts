import { decideInheritedMcpPolicy, type InheritedMcpPolicy, type McpDetection } from "@meguribi/core";
import { redactDiagnosticText } from "./redact.js";

export function detectMcpConnection(text: string): McpDetection {
  // Detection uses in-memory event text; persisted alerts are redacted below.
  const safe = text.toLowerCase();
  if (!/(mcp|model context protocol)/.test(safe)) {
    return { detected: false, transport: "unknown" };
  }
  if (/stdio|spawn.*server|server.*process/.test(safe)) {
    return { detected: true, transport: "stdio" };
  }
  if (/https?:\/\/|http endpoint|sse/.test(safe)) {
    return { detected: true, transport: "http" };
  }
  return { detected: true, transport: "unknown" };
}

export function evaluateMcpOutput(input: {
  policy: InheritedMcpPolicy;
  mode: "interactive" | "non-interactive";
  explicitAllow: boolean;
  output: string;
}) {
  return decideInheritedMcpPolicy({
    policy: input.policy,
    mode: input.mode,
    explicitAllow: input.explicitAllow,
    detection: detectMcpConnection(input.output),
  });
}

export function formatMcpSecurityAlert(input: { transport: string; action: "blocked-and-terminated" | "warning" }): string {
  return `SECURITY_ALERT: unexpected-mcp-connection\nTransport: ${redactDiagnosticText(input.transport)}\nAction: ${input.action}`;
}
