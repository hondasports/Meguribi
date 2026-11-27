import { describe, expect, it } from "vitest";
import {
  assertValidWorkflowDefinition,
  validateWorkflowDefinition,
  WorkflowDefinitionError,
  type WorkflowDefinition,
} from "./definition.js";

function deliveryLikeDefinition(): WorkflowDefinition {
  return {
    name: "delivery",
    steps: [
      { id: "plan", kind: "plan" },
      { id: "implement", kind: "implement" },
      { id: "verify", kind: "verify", onFailure: { goto: "fix-after-verify", max: 1 } },
      { id: "review", kind: "review", then: "publish", onChangesRequired: { goto: "fix-after-review", max: 1 } },
      { id: "fix-after-verify", kind: "fix", of: "verify", then: "review" },
      { id: "fix-after-review", kind: "fix", of: "review", then: "publish", onChangesRequired: { goto: "fix-after-review", max: 3 } },
      { id: "publish", kind: "publish" },
    ],
  };
}

function codes(definition: WorkflowDefinition): string[] {
  return validateWorkflowDefinition(definition).map((issue) => issue.code);
}

describe("validateWorkflowDefinition", () => {
  it("accepts the delivery-shaped definition", () => {
    expect(validateWorkflowDefinition(deliveryLikeDefinition())).toEqual([]);
  });

  it("reports duplicate_step_id", () => {
    const definition: WorkflowDefinition = {
      name: "x",
      steps: [
        { id: "plan", kind: "plan" },
        { id: "plan", kind: "plan" },
      ],
    };
    expect(codes(definition)).toContain("duplicate_step_id");
  });

  it("reports unknown_step_reference for then/of/goto", () => {
    const definition: WorkflowDefinition = {
      name: "x",
      steps: [
        { id: "a", kind: "plan", then: "missing-then" },
        { id: "b", kind: "fix", of: "missing-of" },
        { id: "c", kind: "verify", onFailure: { goto: "missing-goto", max: 1 } },
      ],
    };
    expect(codes(definition)).toContain("unknown_step_reference");
  });

  it("reports missing_max", () => {
    const definition: WorkflowDefinition = {
      name: "x",
      steps: [
        { id: "a", kind: "verify", onFailure: { goto: "a" } as never },
      ],
    };
    expect(codes(definition)).toContain("missing_max");
  });

  it("reports invalid_max for zero or non-integer", () => {
    const zero: WorkflowDefinition = {
      name: "x",
      steps: [{ id: "a", kind: "verify", onFailure: { goto: "a", max: 0 } }],
    };
    const fractional: WorkflowDefinition = {
      name: "x",
      steps: [{ id: "a", kind: "verify", onChangesRequired: { goto: "a", max: 1.5 } }],
    };
    expect(codes(zero)).toContain("invalid_max");
    expect(codes(fractional)).toContain("invalid_max");
  });

  it("reports publish_requires_verify_and_review when publish lacks both before it", () => {
    const definition: WorkflowDefinition = {
      name: "x",
      steps: [
        { id: "plan", kind: "plan" },
        { id: "publish", kind: "publish" },
      ],
    };
    expect(codes(definition)).toContain("publish_requires_verify_and_review");
    const onlyVerify: WorkflowDefinition = {
      name: "x",
      steps: [
        { id: "verify", kind: "verify" },
        { id: "publish", kind: "publish" },
      ],
    };
    expect(codes(onlyVerify)).toContain("publish_requires_verify_and_review");
  });

  it("reports implement_requires_verify when no verify follows implement", () => {
    const definition: WorkflowDefinition = {
      name: "x",
      steps: [
        { id: "implement", kind: "implement" },
        { id: "review", kind: "review" },
        { id: "publish", kind: "publish" },
      ],
    };
    expect(codes(definition)).toContain("implement_requires_verify");
  });

  it("reports discuss_requires_approve when discuss has no approval before implementation", () => {
    const definition: WorkflowDefinition = {
      name: "x",
      steps: [
        { id: "discuss", kind: "discuss" },
        { id: "plan", kind: "plan" },
        { id: "implement", kind: "implement" },
        { id: "verify", kind: "verify" },
        { id: "review", kind: "review" },
        { id: "publish", kind: "publish" },
      ],
    };
    expect(codes(definition)).toContain("discuss_requires_approve");

    const withApprove: WorkflowDefinition = {
      name: "x",
      steps: [
        { id: "discuss", kind: "discuss" },
        { id: "approve-discuss", kind: "approve", of: "discuss" },
        { id: "plan", kind: "plan" },
        { id: "implement", kind: "implement" },
        { id: "verify", kind: "verify" },
        { id: "review", kind: "review" },
        { id: "publish", kind: "publish" },
      ],
    };
    expect(codes(withApprove)).not.toContain("discuss_requires_approve");
  });

  it("collects multiple issues instead of stopping at the first", () => {
    const definition: WorkflowDefinition = {
      name: "x",
      steps: [
        { id: "a", kind: "plan" },
        { id: "a", kind: "plan" },
        { id: "publish", kind: "publish" },
      ],
    };
    const result = codes(definition);
    expect(result).toContain("duplicate_step_id");
    expect(result).toContain("publish_requires_verify_and_review");
  });
});

describe("assertValidWorkflowDefinition", () => {
  it("throws WorkflowDefinitionError with issues for invalid definitions", () => {
    const invalid: WorkflowDefinition = {
      name: "x",
      steps: [
        { id: "a", kind: "plan" },
        { id: "a", kind: "plan" },
      ],
    };
    let caught: unknown;
    try {
      assertValidWorkflowDefinition(invalid);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkflowDefinitionError);
    expect((caught as WorkflowDefinitionError).issues.length).toBeGreaterThan(0);
    expect((caught as WorkflowDefinitionError).issues[0]?.code).toBe("duplicate_step_id");
  });

  it("does not throw for valid definitions", () => {
    expect(() => assertValidWorkflowDefinition(deliveryLikeDefinition())).not.toThrow();
  });
});
