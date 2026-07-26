import { describe, expect, it } from "vitest";
import { decidePermission } from "./permission-policy.js";

const base = {
  requestId: "r-1",
  sessionId: "s-1",
  tool: "terminal",
  summary: "run command",
  targetWithinWorktree: true,
  protectedPath: false,
  destructive: false,
  network: false,
} as const;

describe("decidePermission", () => {
  it("allows an explicitly allowlisted command", () => {
    expect(decidePermission({ ...base, operation: "command", command: "pnpm test" }, {
      mode: "non-interactive",
      allowedCommands: ["pnpm test"],
    })).toMatchObject({ outcome: "approve" });
  });

  it("denies protected and outside-worktree operations before confirmation", () => {
    expect(decidePermission({ ...base, operation: "file_write", protectedPath: true }, {
      mode: "interactive",
      allowedCommands: [],
    }).outcome).toBe("deny");
    expect(decidePermission({ ...base, operation: "file_read", targetWithinWorktree: false }, {
      mode: "interactive",
      allowedCommands: [],
    }).outcome).toBe("deny");
  });

  it("fails closed for unknown non-interactive operations", () => {
    expect(decidePermission({ ...base, operation: "unknown" }, {
      mode: "non-interactive",
      allowedCommands: [],
    })).toMatchObject({ outcome: "deny" });
  });

  it("denies a network flag even when the operation otherwise looks safe", () => {
    expect(decidePermission({ ...base, operation: "file_read", network: true }, {
      mode: "non-interactive",
      allowedCommands: [],
    })).toMatchObject({ outcome: "deny" });
  });
});
