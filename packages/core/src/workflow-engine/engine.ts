import {
  assertValidWorkflowDefinition,
  WorkflowDefinitionError,
  type StepDefinition,
  type StepKind,
  type WorkflowDefinition,
} from "./definition.js";
import type { WorkflowEvent } from "./events.js";

export type StepOutcome<R = unknown> =
  | { type: "continue" }
  | { type: "failure" }
  | { type: "changes_required" }
  | { type: "stop"; result: R };

export interface StepHandlerContext<C> {
  step: StepDefinition;
  context: C;
  visit: number;
}

export type StepHandler<C, R = unknown> = (
  ctx: StepHandlerContext<C>,
) => Promise<StepOutcome<R>>;

export interface StepStateRecord {
  stepId: string;
  kind: StepKind;
  status: "running" | "completed" | "failed";
  visit: number;
  outcome?: StepOutcome["type"];
  startedAt: string;
  finishedAt?: string;
}

export interface StepStateStore {
  save(record: StepStateRecord): Promise<void>;
}

export type WorkflowRunResult<R> =
  | { type: "stopped"; stepId: string; result: R }
  | { type: "completed" }
  | { type: "loop_limit"; stepId: string; transition: "onFailure" | "onChangesRequired" }
  | { type: "unhandled"; stepId: string; outcome: "failure" | "changes_required" };

export interface RunWorkflowInput<C, R> {
  runId: string;
  definition: WorkflowDefinition;
  handlers: Partial<Record<StepKind, StepHandler<C, R>>>;
  context: C;
  startAt?: string;
  stepStore?: StepStateStore;
  onEvent?: (event: WorkflowEvent) => void;
  now?: () => Date;
}

export class MissingStepHandlerError extends Error {
  readonly kind: StepKind;

  constructor(kind: StepKind) {
    super(`No handler registered for step kind: ${kind}`);
    this.name = "MissingStepHandlerError";
    this.kind = kind;
  }
}

/**
 * 定義を逐次実行するワークフローエンジン。
 * delivery 固有の判断はハンドラー側に閉じ込め、ここでは遷移と上限だけを扱う。
 */
export async function runWorkflow<C, R>(
  input: RunWorkflowInput<C, R>,
): Promise<WorkflowRunResult<R>> {
  const { definition, runId } = input;
  const now = input.now ?? (() => new Date());
  assertValidWorkflowDefinition(definition);

  const steps = definition.steps;
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (input.startAt !== undefined && !byId.has(input.startAt)) {
    throw new WorkflowDefinitionError([
      {
        code: "unknown_step_reference",
        message: `startAt references unknown step: ${input.startAt}`,
      },
    ]);
  }

  const emit = (event: WorkflowEvent): void => {
    try {
      input.onEvent?.(event);
    } catch {
      // 進捗表示の例外でワークフローの結果を変えない
    }
  };

  let currentId: string | undefined = input.startAt ?? steps[0]?.id;
  const visits = new Map<string, number>();
  const transitionUses = new Map<string, number>();

  emit({ type: "workflow.started", runId, workflow: definition.name, at: now().toISOString() });

  const finish = (result: WorkflowRunResult<R>): WorkflowRunResult<R> => {
    emit({
      type: "workflow.finished",
      runId,
      workflow: definition.name,
      outcome: result.type as WorkflowRunResult<unknown>["type"],
      at: now().toISOString(),
    });
    return result;
  };

  while (currentId !== undefined) {
    const step = byId.get(currentId);
    if (step === undefined) {
      throw new WorkflowDefinitionError([
        {
          code: "unknown_step_reference",
          stepId: currentId,
          message: `unknown step: ${currentId}`,
        },
      ]);
    }
    const handler = input.handlers[step.kind];
    if (handler === undefined) {
      throw new MissingStepHandlerError(step.kind);
    }

    const visit = (visits.get(step.id) ?? 0) + 1;
    visits.set(step.id, visit);
    const startedAt = now().toISOString();
    await input.stepStore?.save({
      stepId: step.id,
      kind: step.kind,
      status: "running",
      visit,
      startedAt,
    });
    emit({
      type: "workflow.step.started",
      runId,
      stepId: step.id,
      kind: step.kind,
      visit,
      at: startedAt,
    });

    let outcome: StepOutcome<R>;
    try {
      outcome = await handler({ step, context: input.context, visit });
    } catch (error) {
      const finishedAt = now().toISOString();
      await input.stepStore?.save({
        stepId: step.id,
        kind: step.kind,
        status: "failed",
        visit,
        startedAt,
        finishedAt,
      });
      emit({
        type: "workflow.step.failed",
        runId,
        stepId: step.id,
        kind: step.kind,
        message: error instanceof Error ? error.message : String(error),
        at: finishedAt,
      });
      throw error;
    }

    const finishedAt = now().toISOString();
    await input.stepStore?.save({
      stepId: step.id,
      kind: step.kind,
      status: "completed",
      visit,
      outcome: outcome.type,
      startedAt,
      finishedAt,
    });
    emit({
      type: "workflow.step.completed",
      runId,
      stepId: step.id,
      kind: step.kind,
      outcome: outcome.type,
      at: finishedAt,
    });

    if (outcome.type === "stop") {
      return finish({ type: "stopped", stepId: step.id, result: outcome.result });
    }

    if (outcome.type === "failure" || outcome.type === "changes_required") {
      const key = outcome.type === "failure" ? "onFailure" : "onChangesRequired";
      const transition = step[key];
      if (transition === undefined) {
        return finish({ type: "unhandled", stepId: step.id, outcome: outcome.type });
      }
      const useKey = `${step.id}:${key}`;
      const uses = (transitionUses.get(useKey) ?? 0) + 1;
      transitionUses.set(useKey, uses);
      if (uses <= transition.max) {
        currentId = transition.goto;
        continue;
      }
      return finish({ type: "loop_limit", stepId: step.id, transition: key });
    }

    // continue
    if (step.then !== undefined) {
      currentId = step.then;
      continue;
    }
    const index = steps.findIndex((candidate) => candidate.id === step.id);
    const next = steps[index + 1];
    if (next === undefined) {
      return finish({ type: "completed" });
    }
    currentId = next.id;
  }

  return finish({ type: "completed" });
}
