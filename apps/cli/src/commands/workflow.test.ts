import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../program.js";
import {
  runWorkflowListCommand,
  runWorkflowRunCommand,
  runWorkflowValidateCommand,
} from "./workflow.js";

const discussToPrYaml = `name: discuss-to-pr
steps:
  - id: discuss
    kind: discuss
  - id: approve
    kind: approve
    of: discuss
  - id: specify
    kind: specify
  - id: plan
    kind: plan
  - id: implement
    kind: implement
  - id: verify
    kind: verify
  - id: review
    kind: review
    onChangesRequired: { goto: fix, max: 3 }
  - id: fix
    kind: fix
    then: verify
  - id: publish
    kind: publish
`;

const noReviewYaml = `name: no-review
steps:
  - id: implement
    kind: implement
  - id: verify
    kind: verify
  - id: publish
    kind: publish
`;

describe("runWorkflowValidateCommand", () => {
  it("prints OK for a valid workflow", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runWorkflowValidateCommand("discuss-to-pr.yml", {
      readFile: async () => discussToPrYaml,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.join("")).toBe("OK: discuss-to-pr (9 steps)\n");
    expect(stderr.join("")).toBe("");
  });

  it("prints one line per validation issue and exits 1", async () => {
    const stderr: string[] = [];

    const result = await runWorkflowValidateCommand("no-review.yml", {
      readFile: async () => noReviewYaml,
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.join("")).toBe(
      "publish_requires_verify_and_review publish: publish requires both verify and review earlier in definition order\n",
    );
  });

  it("prints parse errors with object paths and exits 1", async () => {
    const stderr: string[] = [];

    const result = await runWorkflowValidateCommand("invalid.yml", {
      readFile: async () => "name: invalid\nsteps:\n  - id: one\n    kind: deploy\n",
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.join("")).toContain("steps.0.kind");
  });
});


describe("runWorkflowListCommand", () => {
  it("lists the built-in delivery workflow and repository workflows with step ids", async () => {
    const stdout: string[] = [];

    const repositoryPath = path.resolve("/repo");
    const result = await runWorkflowListCommand({ repoPath: "/repo" }, {
      loadWorkflows: async () => [
        {
          path: path.join(repositoryPath, ".meguribi", "workflows", "discuss-to-pr.yml"),
          definition: {
            name: "discuss-to-pr",
            steps: [
              { id: "discuss", kind: "discuss" },
              { id: "publish", kind: "publish" },
            ],
          },
        },
      ],
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.join("")).toBe(
      "delivery (built-in, 7 steps): plan, implement, verify, review, fix-after-verify, fix-after-review, publish\n" +
        "discuss (built-in, 2 steps): discuss, approve\n" +
        "discuss-to-pr (built-in, 10 steps): discuss, approve, specify, plan, implement, verify, review, fix-after-verify, fix-after-review, publish\n" +
        "discuss-to-pr (.meguribi/workflows/discuss-to-pr.yml, 2 steps): discuss, publish\n",
    );
  });

  it("reports broken repository workflow files without failing the whole list", async () => {
    const stdout: string[] = [];

    const repositoryPath = path.resolve("/repo");
    const result = await runWorkflowListCommand({ repoPath: "/repo" }, {
      loadWorkflows: async () => [
        {
          path: path.join(repositoryPath, ".meguribi", "workflows", "broken.yml"),
          error: "Invalid workflow definition",
        },
      ],
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.join("")).toContain(
      ".meguribi/workflows/broken.yml: error: Invalid workflow definition\n",
    );
  });
});


describe("runWorkflowRunCommand early run id reporting", () => {
  function wiringWithStateObserver(observe: (runId: string) => void) {
    return {
      inheritedMcpPolicy: "deny",
      deps: {
        discussion: {
          runStore: {
            saveArtifact: async () => "artifact",
            readArtifact: async () => null,
          },
          onStateChange: (state: { runId: string }) => observe(state.runId),
        },
        delivery: {},
        specify: async () => {
          throw new Error("not used");
        },
      },
    } as never;
  }

  function runState(runId: string) {
    return {
      schemaVersion: 1,
      runId,
      repository: "owner/repo",
      issueNumber: 22,
      command: "discuss",
      status: "created",
      completedSteps: [],
      branch: "meguribi/issue-22",
      worktreePath: "/tmp/worktree",
      baseRef: "origin/main",
      baseSha: "base",
      headSha: "head",
      remoteIdentity: "github.com/owner/repo",
      pullRequestNumber: null,
      agentSessions: {},
      fixAttempts: 0,
      maxFixAttempts: 0,
      createdAt: "2026-11-28T00:00:00.000Z",
      updatedAt: "2026-11-28T00:00:00.000Z",
    } as never;
  }

  it("reports the persistent run id before a slow discussion completes and preserves the existing observer", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const observed: string[] = [];
    let sawRunIdBeforeSlowWait = false;

    const result = await runWorkflowRunCommand("discuss-to-pr", "owner/repo#22", {}, {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      createDependencies: async () => wiringWithStateObserver((runId) => observed.push(runId)),
      runWorkflow: async (_input, workflowDeps) => {
        await workflowDeps.discussion.onStateChange?.(runState("run-early"));
        sawRunIdBeforeSlowWait = stdout.join("").includes("Run ID: run-early\n");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { runId: "run-early", status: "awaiting_human", reasons: [] };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(sawRunIdBeforeSlowWait).toBe(true);
    expect(observed).toEqual(["run-early"]);
    expect(stdout.join("").match(/Run ID: /g)).toHaveLength(1);
    expect(stdout.join("")).toContain("承認すると specify 以降");
    expect(stderr.join("")).toBe("");
  });

  it("keeps stdout machine-readable in json mode while preserving the existing observer", async () => {
    const stdout: string[] = [];
    const observed: string[] = [];

    const result = await runWorkflowRunCommand(
      "discuss-to-pr",
      "owner/repo#22",
      { json: true },
      {
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
        createDependencies: async () => wiringWithStateObserver((runId) => observed.push(runId)),
        runWorkflow: async (_input, workflowDeps) => {
          await workflowDeps.discussion.onStateChange?.(runState("run-json"));
          return { runId: "run-json", status: "awaiting_human", reasons: [] };
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(observed).toEqual(["run-json"]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ runId: "run-json" });
    expect(stdout.join("")).not.toContain("Run ID: ");
  });
});

describe("workflow command registration", () => {
  it("registers meguribi workflow validate <file>", async () => {
    const stdout: string[] = [];
    const requested: string[] = [];
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = createProgram({
        readFile: async (pathname) => {
          requested.push(pathname);
          return discussToPrYaml;
        },
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
      });
      await program.parseAsync(["node", "meguribi", "workflow", "validate", "custom.yml"]);

      expect(process.exitCode).toBe(0);
      expect(requested).toEqual(["custom.yml"]);
      expect(stdout.join("")).toBe("OK: discuss-to-pr (9 steps)\n");
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

describe("workflow list command registration", () => {
  it("registers meguribi workflow list --repo-path <path>", async () => {
    const stdout: string[] = [];
    const requested: string[] = [];
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = createProgram({
        loadWorkflows: async (repoPath) => {
          requested.push(repoPath);
          return [];
        },
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
      });
      await program.parseAsync(["node", "meguribi", "workflow", "list", "--repo-path", "/repo"]);

      expect(process.exitCode).toBe(0);
      expect(requested).toEqual([path.resolve("/repo")]);
      expect(stdout.join("")).toContain("delivery (built-in, 7 steps): plan, implement, verify");
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
