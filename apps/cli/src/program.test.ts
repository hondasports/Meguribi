import { describe, expect, it } from "vitest";
import { createFakeDeliveryDeps } from "@meguribi/adapters";
import type { DevinDiagnosis } from "@meguribi/schemas";
import { runResumeCommand, runRunCommand } from "./commands/run.js";
import { runDoctor } from "./program.js";
import { parseIssueTarget } from "./target.js";

const healthy: DevinDiagnosis = {
  executable: { status: "ok", path: "devin" },
  version: { status: "supported", raw: "3000.2.17" },
  authentication: { status: "authenticated" },
  acp: { status: "supported" },
  inheritedMcpPolicy: "allow",
  runnable: true,
  warnings: [],
  errors: [],
};

const configResult = {
  kind: "devin" as const,
  config: {
    executable: "devin",
    transport: "acp" as const,
    gracefulShutdownMs: 1,
    terminateTimeoutMs: 1,
    forceKillTimeoutMs: 1,
    startupTimeoutMs: 1000,
    turnTimeoutMinutes: 1,
    inheritedMcpPolicy: "allow" as const,
  },
  snapshot: { executable: "devin", inheritedMcpPolicy: "allow" },
};

describe("runDoctor", () => {
  it("prints human output and exits 0 when runnable", async () => {
    const chunks: string[] = [];
    const result = await runDoctor(
      {},
      {
        loadConfig: async () => configResult,
        diagnoseDevin: async () => healthy,
        stdout: (text) => {
          chunks.push(text);
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("✓ Devin CLI: 3000.2.17");
  });

  it("prints JSON only when --json is set", async () => {
    const chunks: string[] = [];
    const result = await runDoctor(
      { json: true },
      {
        loadConfig: async () => configResult,
        diagnoseDevin: async () => ({ ...healthy, runnable: false }),
        stdout: (text) => {
          chunks.push(text);
        },
      },
    );
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(chunks.join("")) as DevinDiagnosis;
    expect(parsed.runnable).toBe(false);
    expect(chunks.join("")).not.toContain("✓");
  });

  it("passes nonInteractive to diagnose and still emits structured JSON for warn policy", async () => {
    const chunks: string[] = [];
    let sawNonInteractive: boolean | undefined;
    let loadConfigNonInteractive: boolean | undefined;
    let sawMinimum: string | undefined;

    const blocked: DevinDiagnosis = {
      ...healthy,
      inheritedMcpPolicy: "warn",
      runnable: false,
      warnings: [
        {
          code: "inherited_mcp",
          message: "Saved Devin settings may include MCP servers",
        },
      ],
      errors: [
        {
          code: "policy_blocked",
          message: "inheritedMcpPolicy is warn, which is not allowed in non-interactive mode",
          nextAction: "Set inheritedMcpPolicy to allow or deny, or run interactively",
        },
      ],
    };

    const result = await runDoctor(
      { json: true, nonInteractive: true },
      {
        loadConfig: async (options) => {
          loadConfigNonInteractive = options?.nonInteractive;
          return {
            ...configResult,
            config: { ...configResult.config, inheritedMcpPolicy: "warn" as const },
          };
        },
        diagnoseDevin: async (options) => {
          sawNonInteractive = options.nonInteractive;
          sawMinimum = options.minimumSupportedVersion;
          return blocked;
        },
        stdout: (text) => {
          chunks.push(text);
        },
      },
    );

    expect(loadConfigNonInteractive).toBe(false);
    expect(sawNonInteractive).toBe(true);
    expect(sawMinimum).toBe("3000.0.0");
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(chunks.join("")) as DevinDiagnosis;
    expect(parsed.errors.some((error) => error.code === "policy_blocked")).toBe(true);
    expect(parsed.runnable).toBe(false);
  });
});

describe("parseIssueTarget", () => {
  it("parses owner/repo#123 and issue URLs", () => {
    expect(parseIssueTarget("owner/repo#22")).toEqual({
      repository: "owner/repo",
      issueNumber: 22,
    });
    expect(parseIssueTarget("https://github.com/owner/repo/issues/22")).toEqual({
      repository: "owner/repo",
      issueNumber: 22,
    });
  });

  it("rejects path traversal segments", () => {
    expect(() => parseIssueTarget("../repo#1")).toThrow(/Invalid repository|owner segment/i);
    expect(() => parseIssueTarget("owner/..#1")).toThrow(/Invalid repository|repo segment/i);
  });
});

describe("run / resume DI", () => {
  it("runs delivery with fakes and prints JSON on stdout / progress on stderr", async () => {
    const bundle = createFakeDeliveryDeps({
      github: { issue: { number: 22, labels: ["agent:ready"] } },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runRunCommand(
      "owner/repo#22",
      {
        json: true,
        allowInheritedMcp: true,
        nonInteractive: true,
      },
      {
        delivery: {
          ...bundle.deps,
        },
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
        installSignalHandlers: () => () => undefined,
      },
    );

    // With DI, inherit warn unless tests override; allowInheritedMcp=true unblocks warn.
    expect(stderr.join("")).toContain("Starting delivery");
    expect(result.exitCode).toBe(0);
    expect(result.result?.published).toBe(true);
    const parsed = JSON.parse(stdout.join("")) as { published: boolean; runId: string };
    expect(parsed.published).toBe(true);
    expect(parsed.runId).toBeTruthy();
    expect(bundle.git.calls.counts.commit).toBe(1);
    expect(bundle.github.calls.counts.createDraftPullRequest).toBe(1);
    expect("createDraftPullRequest" in bundle.devin).toBe(false);
  });

  it("resumes a completed implementation run via DI fakes", async () => {
    const bundle = createFakeDeliveryDeps({
      github: { issue: { number: 22, labels: ["agent:ready"] } },
    });
    const created = await bundle.runStore.create({
      repository: "owner/repo",
      issueNumber: 22,
      command: "run",
      maxFixAttempts: 2,
      identity: {
        repository: "owner/repo",
        issueNumber: 22,
        branch: "meguribi/issue-22",
        worktreePath: "/worktree",
        baseRef: "origin/main",
        baseSha: "base-sha",
        headSha: "head-sha",
        remoteIdentity: "github.com/owner/repo",
      },
    });
    const plan = await bundle.deps.codex.createPlan({
      repositoryPath: "/repo",
      issue: await bundle.deps.github.getIssue("owner/repo", 22),
      repositoryRules: "rules",
      completionCriteria: ["ok"],
      outOfScope: [],
    });
    await bundle.runStore.saveArtifact(created.runId, "plan.json", plan);
    await bundle.runStore.saveArtifact(created.runId, "implementation-result.json", {
      status: "completed",
      sessionId: "seed",
      startedAt: "2026-07-26T12:00:00.000Z",
      finishedAt: "2026-07-26T12:01:00.000Z",
      durationMs: 60_000,
      changedFiles: ["src/example.ts"],
      reportedFiles: ["src/example.ts"],
      unresolvedItems: [],
      permissionDecisions: [],
      artifactPaths: { root: "/a" },
      publishable: true,
    });
    await bundle.runStore.update(created.runId, {
      status: "verifying",
      currentStep: "implementation_completed",
      completedSteps: ["implementation_completed"],
    });

    const stdout: string[] = [];
    const result = await runResumeCommand(
      "owner/repo#22",
      { json: true, runId: created.runId, allowInheritedMcp: true, nonInteractive: true },
      {
        delivery: bundle.deps,
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
        installSignalHandlers: () => () => undefined,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.result?.published).toBe(true);
    expect(JSON.parse(stdout.join()).published).toBe(true);
  });
});
