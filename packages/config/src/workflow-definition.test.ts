import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateWorkflowDefinition } from "@meguribi/core";
import {
  loadRepositoryWorkflows,
  parseWorkflowDefinition,
  WorkflowDefinitionParseError,
} from "./workflow-definition.js";

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

describe("parseWorkflowDefinition", () => {
  it("parses the discuss-to-pr workflow from the design", () => {
    const definition = parseWorkflowDefinition(discussToPrYaml, "discuss-to-pr.yml");

    expect(definition).toEqual({
      name: "discuss-to-pr",
      steps: [
        { id: "discuss", kind: "discuss" },
        { id: "approve", kind: "approve", of: "discuss" },
        { id: "specify", kind: "specify" },
        { id: "plan", kind: "plan" },
        { id: "implement", kind: "implement" },
        { id: "verify", kind: "verify" },
        {
          id: "review",
          kind: "review",
          onChangesRequired: { goto: "fix", max: 3 },
        },
        // oxlint-disable-next-line unicorn/no-thenable -- ワークフロー定義の `then` はデータフィールドであり thenable ではない
        { id: "fix", kind: "fix", then: "verify" },
        { id: "publish", kind: "publish" },
      ],
    });
    expect(validateWorkflowDefinition(definition)).toEqual([]);
  });

  it("reports an unknown step kind with its YAML object path", () => {
    let caught: unknown;
    try {
      parseWorkflowDefinition("name: invalid\nsteps:\n  - id: one\n    kind: deploy\n", "invalid.yml");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkflowDefinitionParseError);
    const error = caught as WorkflowDefinitionParseError;
    expect(error.path).toBe("steps.0.kind");
    expect(error.issues).toContain("steps.0.kind");
  });

  it("reports unknown keys with their object path", () => {
    let caught: unknown;
    try {
      parseWorkflowDefinition("name: invalid\nsteps:\n  - id: one\n    kind: plan\n    command: npm test\n", "invalid.yml");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkflowDefinitionParseError);
    expect((caught as WorkflowDefinitionParseError).path).toBe("steps.0.command");
  });
});

describe("loadRepositoryWorkflows", () => {
  it("returns an empty list when the workflows directory does not exist", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "meguribi-workflows-"));
    try {
      await expect(loadRepositoryWorkflows(repository)).resolves.toEqual([]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("loads yml and yaml files in name order and attaches errors only to broken files", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "meguribi-workflows-"));
    try {
      const directory = path.join(repository, ".meguribi", "workflows");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "a-valid.yml"), discussToPrYaml, "utf8");
      await writeFile(
        path.join(directory, "z-broken.yaml"),
        "name: broken\nsteps:\n  - id: one\n    kind: deploy\n",
        "utf8",
      );
      await writeFile(path.join(directory, "ignored.txt"), "name: ignored\nsteps: []\n", "utf8");

      const result = await loadRepositoryWorkflows(repository);

      expect(result.map((entry) => path.basename(entry.path))).toEqual([
        "a-valid.yml",
        "z-broken.yaml",
      ]);
      expect(result[0]?.definition?.name).toBe("discuss-to-pr");
      expect(result[0]?.error).toBeUndefined();
      expect(result[1]?.definition).toBeUndefined();
      expect(result[1]?.error).toContain("steps.0.kind");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});
