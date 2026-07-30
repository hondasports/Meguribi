import { describe, expect, it } from "vitest";
import { ProcessError } from "@meguribi/process";
import { diagnoseRepository, type InitCommandRunner } from "./diagnose.js";

class QueueRunner implements InitCommandRunner {
  readonly calls: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];

  constructor(
    private readonly responses: Array<{ exitCode: number | null; stdout: string; stderr: string }>,
  ) {}

  async run(executable: string, args: readonly string[], cwd: string) {
    this.calls.push({ executable, args, cwd });
    const response = this.responses.shift();
    if (!response) throw new Error("response queue exhausted");
    return response;
  }
}

describe("repository init diagnostics", () => {
  it("normalizes the Git remote, checks GitHub identity, and reports the default branch", async () => {
    const runner = new QueueRunner([
      { exitCode: 0, stdout: "git version 2.50.0\n", stderr: "" },
      { exitCode: 0, stdout: "gh version 2.75.0\n", stderr: "" },
      { exitCode: 0, stdout: "C:\\repo\n", stderr: "" },
      { exitCode: 0, stdout: "git@github.com:Owner/Repo.git\n", stderr: "" },
      { exitCode: 0, stdout: "origin/main\n", stderr: "" },
      { exitCode: 0, stdout: "Logged in\n", stderr: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify({ nameWithOwner: "owner/repo", defaultBranchRef: { name: "main" } }),
        stderr: "",
      },
    ]);

    const result = await diagnoseRepository({ repositoryPath: "C:\\repo", runner });

    expect(result.runnable).toBe(true);
    expect(result.repository).toBe("Owner/Repo");
    expect(result.githubRepository).toBe("owner/repo");
    expect(result.defaultBranch).toBe("main");
    expect(result.githubAuthenticated).toBe(true);
    expect(result.dependencies).toEqual([
      { name: "git", status: "available", version: "git version 2.50.0" },
      { name: "gh", status: "available", version: "gh version 2.75.0" },
    ]);
    expect(runner.calls.every((call) => call.executable !== "codex")).toBe(true);
    expect(runner.calls.every((call) => call.executable !== "cmd.exe")).toBe(true);
    expect(runner.calls[5]?.args).toEqual(["auth", "status"]);
  });

  it("fails closed with a concrete next action when gh is missing", async () => {
    const runner: InitCommandRunner = {
      async run(executable, args) {
        if (executable === "gh") {
          throw new ProcessError("executable_not_found", "missing");
        }
        if (args[0] === "--version") {
          return { exitCode: 0, stdout: `${executable} version\n`, stderr: "" };
        }
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: "C:\\repo\n", stderr: "" };
        if (args[0] === "remote")
          return { exitCode: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
        return { exitCode: 0, stdout: "origin/main\n", stderr: "" };
      },
    };

    const result = await diagnoseRepository({ repositoryPath: "C:\\repo", runner });

    expect(result.runnable).toBe(false);
    expect(result.dependencies.find((dependency) => dependency.name === "gh")).toMatchObject({
      status: "missing",
    });
    expect(result.errors.join(" ")).toMatch(/GitHub CLI is missing/);
  });

  it("fails closed when GitHub authentication is unavailable", async () => {
    const runner = new QueueRunner([
      { exitCode: 0, stdout: "git version\n", stderr: "" },
      { exitCode: 0, stdout: "gh version\n", stderr: "" },
      { exitCode: 0, stdout: "C:\\repo\n", stderr: "" },
      { exitCode: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" },
      { exitCode: 0, stdout: "origin/main\n", stderr: "" },
      { exitCode: 1, stdout: "not logged in\n", stderr: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify({ nameWithOwner: "owner/repo", defaultBranchRef: { name: "main" } }),
        stderr: "",
      },
    ]);

    const result = await diagnoseRepository({ repositoryPath: "C:\\repo", runner });

    expect(result.runnable).toBe(false);
    expect(result.githubAuthenticated).toBe(false);
    expect(result.errors.join(" ")).toMatch(/authentication failed/i);
  });
});
