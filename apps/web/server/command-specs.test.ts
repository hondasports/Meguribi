import { describe, expect, it } from "vitest";
import { buildCliArgs, redactOutput } from "./command-specs.js";

const platformRepoPath = process.platform === "win32" ? "C:\\workspace\\todo" : "/tmp/meguribi-todo";

describe("command bridge", () => {
  it("builds a safe local run command without a shell string", () => {
    expect(
      buildCliArgs({
        command: "run",
        target: "local/todo#1",
        options: {
          local: true,
          repoPath: platformRepoPath,
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
      platformRepoPath,
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

  it("passes a plan user request as a dedicated CLI option", () => {
    expect(
      buildCliArgs({
        command: "plan",
        target: "local/todo#1",
        options: {
          userRequest: "WEBでTODOアプリを作って。",
          repoPath: platformRepoPath,
        },
      }),
    ).toEqual([
      "exec",
      "tsx",
      "apps/cli/src/index.ts",
      "plan",
      "local/todo#1",
      "--repo-path",
      platformRepoPath,
      "--request",
      "WEBでTODOアプリを作って。",
      "--json",
    ]);
  });

  it("uses the repository path as init's positional path", () => {
    expect(
      buildCliArgs({
        command: "init",
        target: "local/todo#1",
        options: {
          repoPath: platformRepoPath,
          implementer: "devin",
          nonInteractive: true,
        },
      }),
    ).toEqual([
      "exec",
      "tsx",
      "apps/cli/src/index.ts",
      "init",
      platformRepoPath,
      "--implementer",
      "devin",
      "--non-interactive",
      "--json",
    ]);
  });

  it("defaults init to the server working directory instead of an issue target", () => {
    expect(
      buildCliArgs({
        command: "init",
        target: "local/todo#1",
        options: { implementer: "devin" },
      }),
    ).toEqual([
      "exec",
      "tsx",
      "apps/cli/src/index.ts",
      "init",
      ".",
      "--implementer",
      "devin",
      "--json",
    ]);
  });
});
