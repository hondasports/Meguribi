import {
  decideInheritedMcpPolicy,
  type InheritedMcpPolicy,
  type McpDetection,
  type McpPolicyDecision,
} from "@meguribi/core";
import { redactDiagnosticText } from "./redact.js";

// Meguribi 自身が stderr メタデータとして書き込む既知の行（完全一致でのみ除外）。
// devin 自身の "WARN: connected to MCP server ..." 等は除外せず検知対象に残す。
const OWN_METADATA_LINES = new Set([
  "warn: the agent may inherit saved mcp configuration; complete isolation is not guaranteed.",
  "security_alert: unexpected-mcp-connection",
]);

const MCP_MENTION = /mcp|model context protocol/;
const VERB = "(?:connecting|connected|spawned|spawn|launched|starting|established|listening|handshake)";
// mcp 言及（model context protocol 含む）と接続確立動詞の近接。
const VERB_EVIDENCE = new RegExp(
  `(?:mcp|model context protocol)[^\\n]{0,80}?${VERB}|${VERB}[^\\n]{0,80}?(?:mcp|model context protocol)`,
);
// 直接的な transport 証跡: stdio/sse/http endpoint が mcp 言及へ近接。
const TRANSPORT_EVIDENCE = new RegExp(
  `(?:mcp|model context protocol)[^\\n]{0,80}?(?:stdio|https?://|\\bsse\\b|http endpoint)|(?:stdio|https?://|http endpoint)[^\\n]{0,80}?(?:mcp|model context protocol)`,
);
// benign 文脈は行単位でのみ無効化する。rolling buffer 全体へは適用しない——
// 先頭の "no MCP" 行が後続の本物の接続行を打ち消すことを防ぐ。
const BENIGN_LINE = /(no mcp|0 mcp|mcp[^\n]{0,40}(disabled|skipped|skipping|not loaded|unavailable)|may inherit|complete isolation)/;

interface LineHit {
  detected: boolean;
  transport: "stdio" | "http" | "unknown";
}

function evaluateLine(line: string): LineHit {
  const safe = line.trim().toLowerCase();
  if (safe.length === 0 || OWN_METADATA_LINES.has(safe)) {
    return { detected: false, transport: "unknown" };
  }
  if (!MCP_MENTION.test(safe)) {
    return { detected: false, transport: "unknown" };
  }
  const hasVerbEvidence = VERB_EVIDENCE.test(safe);
  const hasTransportEvidence = TRANSPORT_EVIDENCE.test(safe);
  if (!hasVerbEvidence && !hasTransportEvidence) {
    return { detected: false, transport: "unknown" };
  }
  // benign 行は確立動詞を伴わない限り検知しない。
  if (BENIGN_LINE.test(safe) && !new RegExp(VERB).test(safe)) {
    return { detected: false, transport: "unknown" };
  }
  if (/stdio|spawn.{0,60}server|server.{0,60}process/.test(safe)) {
    return { detected: true, transport: "stdio" };
  }
  if (/https?:\/\/|http endpoint|\bsse\b/.test(safe)) {
    return { detected: true, transport: "http" };
  }
  return { detected: true, transport: "unknown" };
}

export function detectMcpConnection(text: string): McpDetection {
  // Detection uses in-memory event text; persisted alerts are redacted below.
  // rolling buffer 全体ではなく行単位で判定し、混在する benign 行と
  // 本物の証跡行が打ち消し合わないようにする。
  let fallback: LineHit | undefined;
  for (const line of text.split("\n")) {
    const hit = evaluateLine(line);
    if (!hit.detected) {
      continue;
    }
    if (hit.transport !== "unknown") {
      return hit;
    }
    fallback ??= hit;
  }
  return fallback ?? { detected: false, transport: "unknown" };
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
