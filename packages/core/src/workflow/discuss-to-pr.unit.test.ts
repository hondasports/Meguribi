import { describe, expect, it } from "vitest";
import type { RunStore } from "../delivery.js";
import type { StepKind } from "../workflow-engine/definition.js";
import { createDiscussToPrWorkflow } from "./discuss-to-pr-definition.js";
import { findContinuationStartStep } from "./discuss-to-pr.js";

function stepRecord(input: {
  stepId: string;
  kind: StepKind;
  status: "running" | "completed" | "failed";
  outcome?: "continue" | "failure" | "changes_required" | "stop";
  startedAt: string;
}) {
  return {
    stepId: input.stepId,
    kind: input.kind,
    status: input.status,
    visit: 1,
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    startedAt: input.startedAt,
    ...(input.status === "running" ? {} : { finishedAt: input.startedAt }),
  };
}

function runStoreWithSteps(records: Record<string, unknown>): RunStore {
  return {
    async readArtifact(_runId: string, name: string) {
      return records[name] ?? null;
    },
  } as RunStore;
}

describe("findContinuationStartStep", () => {
  it("resumes a running review even when an earlier fix step is later in definition order", async () => {
    const definition = createDiscussToPrWorkflow(2);
    const runStore = runStoreWithSteps({
      "steps/fix-after-review.json": stepRecord({
        stepId: "fix-after-review",
        kind: "fix",
        status: "completed",
        outcome: "continue",
        startedAt: "2026-07-26T12:00:03.000Z",
      }),
      "steps/review.json": stepRecord({
        stepId: "review",
        kind: "review",
        status: "running",
        startedAt: "2026-07-26T12:00:04.000Z",
      }),
    });

    await expect(findContinuationStartStep(runStore, "run-1", definition)).resolves.toBe("review");
  });

  it("resumes a failed review instead of routing through an already completed fix step", async () => {
    const definition = createDiscussToPrWorkflow(2);
    const runStore = runStoreWithSteps({
      "steps/fix-after-review.json": stepRecord({
        stepId: "fix-after-review",
        kind: "fix",
        status: "completed",
        outcome: "continue",
        startedAt: "2026-07-26T12:00:03.000Z",
      }),
      "steps/review.json": stepRecord({
        stepId: "review",
        kind: "review",
        status: "failed",
        startedAt: "2026-07-26T12:00:04.000Z",
      }),
    });

    await expect(findContinuationStartStep(runStore, "run-1", definition)).resolves.toBe("review");
  });

  it("uses a completed changes_required outcome to resume at the review fix step", async () => {
    const definition = createDiscussToPrWorkflow(2);
    const runStore = runStoreWithSteps({
      "steps/review.json": stepRecord({
        stepId: "review",
        kind: "review",
        status: "completed",
        outcome: "changes_required",
        startedAt: "2026-07-26T12:00:03.000Z",
      }),
    });

    await expect(findContinuationStartStep(runStore, "run-1", definition)).resolves.toBe(
      "fix-after-review",
    );
  });

  it("does not restart after publish stopped the workflow", async () => {
    const definition = createDiscussToPrWorkflow(2);
    const runStore = runStoreWithSteps({
      "steps/publish.json": stepRecord({
        stepId: "publish",
        kind: "publish",
        status: "completed",
        outcome: "stop",
        startedAt: "2026-07-26T12:00:04.000Z",
      }),
    });

    await expect(findContinuationStartStep(runStore, "run-1", definition)).resolves.toBeNull();
  });
});
