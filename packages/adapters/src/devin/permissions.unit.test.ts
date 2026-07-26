import { describe, expect, it } from "vitest";
import {
  createPermissionMediator,
  normalizeAcpPermissionRequest,
  toAcpPermissionResponse,
} from "./permissions.js";

describe("permission mediator", () => {
  it("is idempotent for duplicate requests and denies after session end", async () => {
    const mediator = createPermissionMediator({ mode: "non-interactive", allowedCommands: ["pnpm test"] });
    const request = {
      requestId: "r-1", sessionId: "s-1", operation: "command" as const, tool: "terminal", summary: "test",
      command: "pnpm test", targetWithinWorktree: true, protectedPath: false, destructive: false, network: false,
    };
    expect(await mediator.decide(request)).toMatchObject({ outcome: "approve" });
    expect(await mediator.decide(request)).toMatchObject({ outcome: "approve" });
    mediator.endSession("s-1");
    expect(await mediator.decide(request)).toMatchObject({ outcome: "deny" });
    expect(await mediator.decide({ ...request, requestId: "r-2" })).toMatchObject({ outcome: "deny" });
    expect(mediator.records()).toHaveLength(2);
  });

  it("fails closed when human confirmation rejects", async () => {
    const mediator = createPermissionMediator(
      { mode: "interactive", allowedCommands: [] },
      async () => { throw new Error("confirmation unavailable"); },
    );
    const decision = await mediator.decide({
      requestId: "r-1", sessionId: "s-1", operation: "unknown", tool: "unknown", summary: "unknown",
      targetWithinWorktree: true, protectedPath: false, destructive: false, network: false,
    });
    expect(decision.outcome).toBe("deny");
  });

  it("normalizes an ACP request without leaking raw input and maps deny to cancellation", () => {
    const request = normalizeAcpPermissionRequest({
      sessionId: "s-1",
      toolCall: {
        toolCallId: "r-1",
        name: "write file",
        title: "edit file",
        kind: "edit",
        locations: [{ path: "../outside/.env" }],
        rawInput: { token: "secretvalue" },
      },
      options: [{ optionId: "allow", name: "allow once", kind: "allow_once" }],
    }, { cwd: "C:/worktrees/issue-1", protectedPaths: [".env*"] });
    expect(request).toMatchObject({
      operation: "file_write",
      targetWithinWorktree: false,
      rawArtifactRef: "raw-events.jsonl#r-1",
    });
    expect(request.summary).not.toContain("secretvalue");
    expect(toAcpPermissionResponse({ outcome: "deny", reason: "blocked" }, [])).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
