import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "./definition.js";
import {
  MissingStepHandlerError,
  runWorkflow,
  type StepHandler,
  type StepOutcome,
  type StepStateRecord,
} from "./engine.js";
import type { WorkflowEvent } from "./events.js";
import { WorkflowDefinitionError } from "./definition.js";

interface RecordedStep {
  stepId: string;
  visit: number;
}

function recordingHandler(
  log: RecordedStep[],
  outcomes: StepOutcome[] | ((stepId: string, visit: number) => StepOutcome),
): StepHandler<undefined> {
  return async (ctx) => {
    log.push({ stepId: ctx.step.id, visit: ctx.visit });
    if (typeof outcomes === "function") {
      return outcomes(ctx.step.id, ctx.visit);
    }
    return outcomes.shift() ?? { type: "continue" };
  };
}

function memoryStore(): { records: StepStateRecord[]; store: { save(record: StepStateRecord): Promise<void> } } {
  const records: StepStateRecord[] = [];
  return {
    records,
    store: {
      async save(record) {
        records.push({ ...record });
      },
    },
  };
}

function collector(): { events: WorkflowEvent[]; onEvent: (event: WorkflowEvent) => void } {
  const events: WorkflowEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

function threeStepDefinition(): WorkflowDefinition {
  return {
    name: "test",
    steps: [
      { id: "plan", kind: "plan" },
      { id: "implement", kind: "implement" },
      { id: "verify", kind: "verify" },
    ],
  };
}

function noopHandler(log: RecordedStep[]): StepHandler<undefined> {
  return recordingHandler(log, [{ type: "continue" }]);
}

describe("runWorkflow", () => {
  it("runs steps in definition order once each and completes", async () => {
    const log: RecordedStep[] = [];
    const result = await runWorkflow({
      runId: "run-1",
      definition: threeStepDefinition(),
      handlers: {
        plan: noopHandler(log),
        implement: noopHandler(log),
        verify: noopHandler(log),
      },
      context: undefined,
    });
    expect(result).toEqual({ type: "completed" });
    expect(log.map((entry) => entry.stepId)).toEqual(["plan", "implement", "verify"]);
    expect(log.every((entry) => entry.visit === 1)).toBe(true);
  });

  it("follows then to skip definition order", async () => {
    const log: RecordedStep[] = [];
    const definition: WorkflowDefinition = {
      name: "test",
      steps: [
        { id: "plan", kind: "plan", then: "verify" },
        { id: "implement", kind: "implement" },
        { id: "verify", kind: "verify" },
      ],
    };
    const result = await runWorkflow({
      runId: "run-1",
      definition,
      handlers: { plan: noopHandler(log), implement: noopHandler(log), verify: noopHandler(log) },
      context: undefined,
    });
    expect(result).toEqual({ type: "completed" });
    expect(log.map((entry) => entry.stepId)).toEqual(["plan", "verify"]);
  });

  it("moves to onFailure.goto up to max times and then stops with loop_limit", async () => {
    const log: RecordedStep[] = [];
    const definition: WorkflowDefinition = {
      name: "test",
      steps: [
        { id: "verify", kind: "verify", onFailure: { goto: "fix", max: 2 } },
        { id: "fix", kind: "fix", of: "verify", then: "verify" },
      ],
    };
    const result = await runWorkflow({
      runId: "run-1",
      definition,
      handlers: {
        verify: recordingHandler(log, () => ({ type: "failure" })),
        fix: recordingHandler(log, () => ({ type: "continue" })),
      },
      context: undefined,
    });
    expect(result).toEqual({ type: "loop_limit", stepId: "verify", transition: "onFailure" });
    const verifyVisits = log.filter((entry) => entry.stepId === "verify");
    expect(verifyVisits).toHaveLength(3);
    expect(verifyVisits.map((entry) => entry.visit)).toEqual([1, 2, 3]);
  });

  it("returns unhandled when changes_required has no transition", async () => {
    const definition: WorkflowDefinition = {
      name: "test",
      steps: [{ id: "review", kind: "review" }],
    };
    const result = await runWorkflow({
      runId: "run-1",
      definition,
      handlers: { review: async () => ({ type: "changes_required" }) },
      context: undefined,
    });
    expect(result).toEqual({ type: "unhandled", stepId: "review", outcome: "changes_required" });
  });

  it("returns the stop result as-is", async () => {
    const definition: WorkflowDefinition = {
      name: "test",
      steps: [
        { id: "plan", kind: "plan" },
        { id: "verify", kind: "verify" },
      ],
    };
    const result = await runWorkflow<undefined, { published: boolean }>({
      runId: "run-1",
      definition,
      handlers: {
        plan: async () => ({ type: "stop", result: { published: false } }),
        verify: async () => ({ type: "continue" }),
      },
      context: undefined,
    });
    expect(result).toEqual({ type: "stopped", stepId: "plan", result: { published: false } });
  });

  it("starts from startAt instead of the first step", async () => {
    const log: RecordedStep[] = [];
    const result = await runWorkflow({
      runId: "run-1",
      definition: threeStepDefinition(),
      handlers: {
        plan: noopHandler(log),
        implement: noopHandler(log),
        verify: noopHandler(log),
      },
      context: undefined,
      startAt: "verify",
    });
    expect(result).toEqual({ type: "completed" });
    expect(log.map((entry) => entry.stepId)).toEqual(["verify"]);
  });

  it("rethrows handler exceptions after recording failed state and event", async () => {
    const { records, store } = memoryStore();
    const { events, onEvent } = collector();
    const failure = new Error("boom");
    const definition: WorkflowDefinition = {
      name: "test",
      steps: [{ id: "verify", kind: "verify" }],
    };
    await expect(
      runWorkflow({
        runId: "run-1",
        definition,
        handlers: {
          verify: async () => {
            throw failure;
          },
        },
        context: undefined,
        stepStore: store,
        onEvent,
      }),
    ).rejects.toBe(failure);
    expect(records.some((record) => record.status === "failed" && record.stepId === "verify")).toBe(true);
    expect(events.some((event) => event.type === "workflow.step.failed")).toBe(true);
  });

  it("ignores onEvent exceptions", async () => {
    const result = await runWorkflow({
      runId: "run-1",
      definition: threeStepDefinition(),
      handlers: {
        plan: async () => ({ type: "continue" }),
        implement: async () => ({ type: "continue" }),
        verify: async () => ({ type: "continue" }),
      },
      context: undefined,
      onEvent: () => {
        throw new Error("observer failure");
      },
    });
    expect(result).toEqual({ type: "completed" });
  });

  it("emits workflow events in order", async () => {
    const { events, onEvent } = collector();
    await runWorkflow({
      runId: "run-1",
      definition: {
        name: "test",
        steps: [{ id: "plan", kind: "plan" }],
      },
      handlers: { plan: async () => ({ type: "continue" }) },
      context: undefined,
      onEvent,
    });
    expect(events.map((event) => event.type)).toEqual([
      "workflow.started",
      "workflow.step.started",
      "workflow.step.completed",
      "workflow.finished",
    ]);
  });

  it("throws MissingStepHandlerError when no handler exists for a kind", async () => {
    const definition: WorkflowDefinition = {
      name: "test",
      steps: [{ id: "plan", kind: "plan" }],
    };
    await expect(
      runWorkflow({ runId: "run-1", definition, handlers: {}, context: undefined }),
    ).rejects.toBeInstanceOf(MissingStepHandlerError);
  });

  it("throws WorkflowDefinitionError for unknown startAt", async () => {
    await expect(
      runWorkflow({
        runId: "run-1",
        definition: threeStepDefinition(),
        handlers: { plan: async () => ({ type: "continue" }) },
        context: undefined,
        startAt: "missing",
      }),
    ).rejects.toBeInstanceOf(WorkflowDefinitionError);
  });

  it("saves running and completed step states", async () => {
    const { records, store } = memoryStore();
    await runWorkflow({
      runId: "run-1",
      definition: { name: "test", steps: [{ id: "plan", kind: "plan" }] },
      handlers: { plan: async () => ({ type: "continue" }) },
      context: undefined,
      stepStore: store,
    });
    expect(records.map((record) => record.status)).toEqual(["running", "completed"]);
    expect(records[0]?.visit).toBe(1);
  });
});
