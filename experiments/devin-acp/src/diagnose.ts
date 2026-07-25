export type IsolationStatus = "isolated" | "blocked" | "unknown";
export type AuthenticationStatus = "authenticated" | "unauthenticated" | "unknown";

export interface DevinCapabilityInput {
  cliVersion: string;
  rootHelp: string;
  acpHelp: string;
  isolation: IsolationStatus;
  authentication: AuthenticationStatus;
  unexpectedMcp?: boolean;
  residualProcesses?: boolean;
}

export interface DevinCapabilityResult {
  acpSupported: boolean;
  mcpIsolation: IsolationStatus;
  isolation: IsolationStatus;
  authentication: AuthenticationStatus;
  devinAcpCandidate: boolean;
  reason: string;
}

export function diagnoseDevinCapabilities(input: DevinCapabilityInput): DevinCapabilityResult {
  const acpSupported = /\bacp\b/i.test(input.rootHelp) && /usage:\s*devin(?:\.exe)?\s+acp/i.test(input.acpHelp);
  const unexpectedMcp = input.unexpectedMcp ?? false;
  const residualProcesses = input.residualProcesses ?? false;
  let reason = "all security gates passed";
  if (!acpSupported) reason = "ACP command is not supported";
  else if (input.isolation !== "isolated") reason = "MCP isolation is not mechanically guaranteed";
  else if (input.authentication !== "authenticated") reason = "authentication cannot be preserved safely";
  else if (unexpectedMcp) reason = "unexpected MCP connection was detected";
  else if (residualProcesses) reason = "MCP child process remained after termination";
  return {
    acpSupported,
    mcpIsolation: input.isolation,
    isolation: input.isolation,
    authentication: input.authentication,
    devinAcpCandidate: reason === "all security gates passed",
    reason
  };
}
