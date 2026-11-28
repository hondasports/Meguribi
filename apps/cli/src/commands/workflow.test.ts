import { describe, expect, it } from "vitest";
import { createProgram } from "../program.js";
import { runWorkflowValidateCommand } from "./workflow.js";

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
