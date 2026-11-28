import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../program.js";
import { runWorkflowListCommand, runWorkflowValidateCommand } from "./workflow.js";

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
