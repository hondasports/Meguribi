import { describe, expect, it } from "vitest";
import { buildCliArgs, redactOutput } from "./command-specs.js";

describe("command bridge", () => {
  it("builds a safe local run command without a shell string", () => {
    expect(
      buildCliArgs({
        command: "run",
        target: "local/todo#1",
        options: {
          local: true,
          repoPath: "C:\\workspace\\todo",
          implementer: "devin",
          branch: "meguribi/issue-1",
          nonInteractive: true,
          allowInheritedMcp: true,
          noPush: true,
          noPr: true,
        },
      }),
    ).toEqual([
      "exec",
      "tsx",
      "apps/cli/src/index.ts",
      "run",
      "local/todo#1",
      "--local",
      "--repo-path",
      "C:\\workspace\\todo",
      "--implementer",
      "devin",
      "--branch",
      "meguribi/issue-1",
      "--non-interactive",
      "--allow-inherited-mcp",
      "--no-push",
      "--no-pr",
      "--json",
    ]);
  });

  it("redacts secret-like values from displayed output", () => {
    expect(redactOutput("token=abc123 password: hunter2 safe=yes")).toBe(
      "token=[REDACTED] password: [REDACTED] safe=yes",
    );
  });

  it("rejects a missing target", () => {
    expect(() => buildCliArgs({ command: "plan" })).toThrow(/target is required/);
  });
});
