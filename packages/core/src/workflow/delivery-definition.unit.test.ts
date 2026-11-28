import { describe, expect, it } from "vitest";
import { validateWorkflowDefinition } from "../workflow-engine/definition.js";
import { createDeliveryWorkflow, DELIVERY_WORKFLOW_NAME } from "./delivery-definition.js";

describe("createDeliveryWorkflow", () => {
  it("defines the built-in delivery steps in the fixed order", () => {
    const definition = createDeliveryWorkflow(2);

    expect(definition.name).toBe(DELIVERY_WORKFLOW_NAME);
    expect(definition.steps.map((step) => step.id)).toEqual([
      "plan",
      "implement",
      "verify",
      "review",
      "fix-after-verify",
      "fix-after-review",
      "publish",
    ]);
    expect(validateWorkflowDefinition(definition)).toEqual([]);
  });
});
