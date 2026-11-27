import { describe, expect, it } from "vitest";
import type { PermissionOperation, PermissionRequest } from "@meguribi/core";
import { createReadOnlyPermissionMediator } from "./read-only-permissions.js";

function request(operation: PermissionOperation): PermissionRequest {
  return {
    requestId: `req-${operation}`,
    sessionId: "session-1",
    operation,
    tool: "test-tool",
    summary: `${operation} summary`,
    targetWithinWorktree: true,
    protectedPath: false,
    destructive: false,
    network: false,
  };
}

describe("createReadOnlyPermissionMediator", () => {
  it("denies file_write operations as read-only", async () => {
    const mediator = createReadOnlyPermissionMediator({ mode: "non-interactive", allowedCommands: [] });
    const decision = await mediator.decide(request("file_write"));
    expect(decision).toMatchObject({ outcome: "deny", reason: "role session is read-only" });
  });

  it("denies command operations as read-only", async () => {
    const mediator = createReadOnlyPermissionMediator({ mode: "non-interactive", allowedCommands: ["pnpm test"] });
    const decision = await mediator.decide(request("command"));
    expect(decision).toMatchObject({ outcome: "deny", reason: "role session is read-only" });
  });

  it("denies git_write operations as read-only", async () => {
    const mediator = createReadOnlyPermissionMediator({ mode: "interactive", allowedCommands: [] });
    const decision = await mediator.decide(request("git_write"));
    expect(decision).toMatchObject({ outcome: "deny", reason: "role session is read-only" });
  });

  it("delegates file_read inside the worktree to the normal policy", async () => {
    const mediator = createReadOnlyPermissionMediator({ mode: "non-interactive", allowedCommands: [] });
    const decision = await mediator.decide(request("file_read"));
    expect(decision.outcome).toBe("approve");
  });

  it("denies file_read outside the worktree through the normal policy", async () => {
    const mediator = createReadOnlyPermissionMediator({ mode: "non-interactive", allowedCommands: [] });
    const decision = await mediator.decide({ ...request("file_read"), targetWithinWorktree: false });
    expect(decision.outcome).toBe("deny");
  });
});
