import { describe, expect, it } from "vitest";
import { validateWorkflowDefinition } from "../workflow-engine/definition.js";
import { createDiscussToPrWorkflow, DISCUSS_TO_PR_WORKFLOW_NAME } from "./discuss-to-pr-definition.js";

describe("createDiscussToPrWorkflow", () => {
  it("passes static validation", () => {
    expect(validateWorkflowDefinition(createDiscussToPrWorkflow(3))).toEqual([]);
  });

  it("orders discuss, approve, specify before delivery steps per spec 6.5", () => {
    const definition = createDiscussToPrWorkflow(3);
    expect(definition.name).toBe(DISCUSS_TO_PR_WORKFLOW_NAME);
    const kinds = definition.steps.map((step) => `${step.id}:${step.kind}`);
    expect(kinds.slice(0, 3)).toEqual(["discuss:discuss", "approve:approve", "specify:specify"]);
    expect(definition.steps[1]?.of).toBe("discuss");
    expect(kinds).toContain("publish:publish");
    const publishIndex = kinds.findIndex((kind) => kind === "publish:publish");
    expect(kinds.indexOf("verify:verify")).toBeLessThan(publishIndex);
    expect(kinds.indexOf("review:review")).toBeLessThan(publishIndex);
  });

  it("bounds every transition with max", () => {
    const definition = createDiscussToPrWorkflow(3);
    for (const step of definition.steps) {
      for (const transition of [step.onFailure, step.onChangesRequired]) {
        if (transition !== undefined) {
          expect(transition.max).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});
