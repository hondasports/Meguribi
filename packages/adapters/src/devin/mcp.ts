import {
  decideInheritedMcpPolicy,
  type InheritedMcpPolicy,
  type McpDetection,
  type McpPolicyDecision,
} from "@meguribi/core";
import { redactDiagnosticText } from "../acp/redact.js";

export function detectMcpConnection(text: string): McpDetection {
  // Detection uses in-memory event text; persisted alerts are redacted below.
  const safe = text.toLowerCase();
  if (!/(mcp|model context protocol)/.test(safe)) {
    return { detected: false, transport: "unknown" };
  }
  if (!/(start|spawn|launch|connect|server|endpoint|transport|stdio|sse)/.test(safe)) {
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

export interface McpPolicyInput {
  policy: InheritedMcpPolicy;
  mode: "interactive" | "non-interactive";
  explicitAllow: boolean;
  confirm?: () => Promise<boolean> | boolean;
  confirmationTimeoutMs?: number;
}

export interface McpPolicyMonitor {
  preflight(): Promise<McpPolicyDecision>;
  observe(chunk: string): McpPolicyDecision;
  current(): McpPolicyDecision;
  warning(): string;
  securityAlert(): string | undefined;
  onDecision(listener: (decision: McpPolicyDecision) => void): () => void;
}

const MAX_OBSERVED_OUTPUT = 64_000;

export function createMcpPolicyMonitor(input: McpPolicyInput): McpPolicyMonitor {
  let observedOutput = "";
  let detection: McpDetection = { detected: false, transport: "unknown" };
  let decision = decideInheritedMcpPolicy({ ...input, detection });
  let alert: string | undefined;
  let notified = false;
  let preflightPromise: Promise<McpPolicyDecision> | undefined;
  let confirmedAllow = false;
  const evaluate = (currentDetection: McpDetection) => decideInheritedMcpPolicy({
    ...input,
    explicitAllow: input.explicitAllow || confirmedAllow,
    detection: currentDetection,
  });
  const listeners = new Set<(value: McpPolicyDecision) => void>();

  const notify = (next: McpPolicyDecision) => {
    if (next.outcome === "allow" || !detection.detected) return;
    for (const listener of listeners) listener(next);
  };

  return {
    async preflight() {
      if (!preflightPromise && decision.outcome === "confirm") {
        preflightPromise = (async () => {
          if (!input.confirm) return { outcome: "block" as const, reason: "interactive MCP confirmation was not provided", warning: decision.warning };
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const confirmed = await Promise.race([
              Promise.resolve(input.confirm()),
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), input.confirmationTimeoutMs ?? 30_000);
              }),
            ]);
            if (confirmed) confirmedAllow = true;
            return confirmed
              ? { outcome: "allow" as const, reason: "interactive MCP confirmation accepted", warning: decision.warning }
              : { outcome: "block" as const, reason: "interactive MCP confirmation was not received", warning: decision.warning };
          } catch {
            return { outcome: "block" as const, reason: "interactive MCP confirmation failed", warning: decision.warning };
          } finally {
            if (timer) clearTimeout(timer);
          }
        })();
      }
      decision = await (preflightPromise ?? Promise.resolve(decision));
      return decision;
    },
    observe(chunk) {
      observedOutput = `${observedOutput}${chunk}`.slice(-MAX_OBSERVED_OUTPUT);
      detection = detectMcpConnection(observedOutput);
      decision = evaluate(detection);
      if (detection.detected && decision.outcome !== "allow") {
        alert ??= formatMcpSecurityAlert({ transport: detection.transport, action: "blocked-and-terminated" });
        if (!notified) {
          notified = true;
          notify(decision);
        }
      }
      return decision;
    },
    current() {
      return decision;
    },
    warning() {
      return decision.warning;
    },
    securityAlert() {
      return alert;
    },
    onDecision(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function formatMcpSecurityAlert(input: { transport: string; action: "blocked-and-terminated" | "warning" }): string {
  return `SECURITY_ALERT: unexpected-mcp-connection\nTransport: ${redactDiagnosticText(input.transport)}\nAction: ${input.action}`;
}
