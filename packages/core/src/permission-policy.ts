export type PermissionOperation =
  | "file_read"
  | "file_write"
  | "command"
  | "git_write"
  | "production_deploy"
  | "secret_access"
  | "external_network"
  | "unknown";

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  operation: PermissionOperation;
  tool: string;
  summary: string;
  targetPath?: string;
  command?: string;
  targetWithinWorktree: boolean;
  protectedPath: boolean;
  destructive: boolean;
  network: boolean;
  rawArtifactRef?: string;
}

export interface PermissionPolicyContext {
  mode: "interactive" | "non-interactive";
  allowedCommands: readonly string[];
}

export interface PermissionDecision {
  outcome: "approve" | "deny" | "confirm";
  reason: string;
  optionId?: string;
}

const alwaysDenyOperations = new Set<PermissionOperation>([
  "git_write",
  "production_deploy",
  "secret_access",
  "external_network",
  "unknown",
]);

export function decidePermission(
  request: PermissionRequest,
  context: PermissionPolicyContext,
): PermissionDecision {
  if (request.network) {
    return { outcome: "deny", reason: "external network access is not allowed" };
  }
  if (!request.targetWithinWorktree) {
    return { outcome: "deny", reason: "target is outside the assigned worktree" };
  }
  if (request.protectedPath) {
    return { outcome: "deny", reason: "target is a protected path" };
  }
  if (request.destructive) {
    return { outcome: "deny", reason: "destructive operations are not permitted" };
  }
  if (alwaysDenyOperations.has(request.operation)) {
    return { outcome: "deny", reason: `${request.operation} is not permitted` };
  }
  if (request.operation === "command") {
    const command = request.command?.trim();
    if (command && context.allowedCommands.includes(command)) {
      return { outcome: "approve", reason: "command is explicitly allowlisted", optionId: "allow-once" };
    }
    return { outcome: "deny", reason: "command is not explicitly allowlisted" };
  }
  if (request.operation === "file_read" || request.operation === "file_write") {
    return { outcome: "approve", reason: "file operation is inside the assigned worktree", optionId: "allow-once" };
  }
  if (context.mode === "non-interactive") {
    return { outcome: "deny", reason: "non-interactive mode is fail-closed" };
  }
  return { outcome: "confirm", reason: "operation requires human confirmation" };
}
