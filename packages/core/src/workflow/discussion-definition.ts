import type { WorkflowDefinition } from "../workflow-engine/definition.js";

export function createDiscussionWorkflow(): WorkflowDefinition {
  return {
    name: "discuss",
    steps: [
      { id: "discuss", kind: "discuss" },
      { id: "approve", kind: "approve", of: "discuss" },
    ],
  };
}
