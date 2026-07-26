import type { InheritedMcpPolicy } from "./inherited-mcp-policy.js";

export type McpTransport = "stdio" | "http" | "unknown";

export interface McpDetection {
  detected: boolean;
  transport: McpTransport;
}

export interface McpPolicyDecision {
  outcome: "allow" | "confirm" | "block";
  reason: string;
  warning: string;
}

export function decideInheritedMcpPolicy(input: {
  policy: InheritedMcpPolicy;
  mode: "interactive" | "non-interactive";
  explicitAllow: boolean;
  detection: McpDetection;
}): McpPolicyDecision {
  const warning = "The agent may inherit saved MCP configuration; complete isolation is not guaranteed.";
  if (input.policy === "allow") {
    return { outcome: "allow", reason: "inherited MCP use was explicitly accepted", warning };
  }
  if (input.policy === "deny" && input.detection.detected) {
    return {
      outcome: "block",
      reason: `detected unexpected ${input.detection.transport} MCP connection`,
      warning,
    };
  }
  if (input.policy === "warn" && input.explicitAllow) {
    return { outcome: "allow", reason: "the user explicitly accepted inherited MCP use", warning };
  }
  if (input.policy === "warn" && input.mode === "interactive") {
    return { outcome: "confirm", reason: "interactive confirmation is required before continuing", warning };
  }
  if (input.policy === "warn") {
    return { outcome: "block", reason: "warn policy is fail-closed in non-interactive mode", warning };
  }
  return { outcome: "allow", reason: "no MCP connection was detected under deny policy", warning };
}
