/**
 * 工程種別が閉じた宣言的ワークフロー定義とその静的検査。
 * 条件式・変数・任意コマンドは持たず、逐次と上限付き遷移だけを表す。
 */
export const STEP_KINDS = [
  "discuss",
  "approve",
  "specify",
  "plan",
  "implement",
  "fix",
  "verify",
  "review",
  "publish",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export interface StepTransition {
  goto: string;
  max: number;
}

export interface StepDefinition {
  id: string;
  kind: StepKind;
  /** continue 時の次の工程（省略時は定義順の次） */
  then?: string;
  /** この工程が対象にする工程（approve の承認対象、fix の修正元） */
  of?: string;
  onFailure?: StepTransition;
  onChangesRequired?: StepTransition;
}

export interface WorkflowDefinition {
  name: string;
  steps: readonly StepDefinition[];
}

export type WorkflowDefinitionIssueCode =
  | "duplicate_step_id"
  | "unknown_step_reference"
  | "missing_max"
  | "invalid_max"
  | "publish_requires_verify_and_review"
  | "implement_requires_verify"
  | "discuss_requires_approve";

export interface WorkflowDefinitionIssue {
  code: WorkflowDefinitionIssueCode;
  stepId?: string;
  message: string;
}

export class WorkflowDefinitionError extends Error {
  readonly issues: readonly WorkflowDefinitionIssue[];

  constructor(issues: readonly WorkflowDefinitionIssue[]) {
    super(
      `Invalid workflow definition: ${issues.map((issue) => issue.code).join(", ")}`,
    );
    this.name = "WorkflowDefinitionError";
    this.issues = issues;
  }
}

function checkTransition(
  step: StepDefinition,
  key: "onFailure" | "onChangesRequired",
  ids: Set<string>,
  issues: WorkflowDefinitionIssue[],
): void {
  const transition = step[key] as StepTransition | undefined;
  if (transition === undefined) {
    return;
  }
  if (!ids.has(transition.goto)) {
    issues.push({
      code: "unknown_step_reference",
      stepId: step.id,
      message: `${key}.goto references unknown step: ${transition.goto}`,
    });
  }
  if (transition.max === undefined || transition.max === null) {
    issues.push({
      code: "missing_max",
      stepId: step.id,
      message: `${key} requires max`,
    });
  } else if (!Number.isInteger(transition.max) || transition.max < 1) {
    issues.push({
      code: "invalid_max",
      stepId: step.id,
      message: `${key}.max must be an integer >= 1`,
    });
  }
}

/**
 * 定義の誤りをすべて集めて返す（最初の1件で止めない）。
 * 問題なければ空配列。
 */
export function validateWorkflowDefinition(definition: WorkflowDefinition): WorkflowDefinitionIssue[] {
  const issues: WorkflowDefinitionIssue[] = [];
  const steps = definition.steps;
  const ids = new Set<string>();

  for (const step of steps) {
    if (ids.has(step.id)) {
      issues.push({
        code: "duplicate_step_id",
        stepId: step.id,
        message: `duplicate step id: ${step.id}`,
      });
    }
    ids.add(step.id);
  }

  for (const step of steps) {
    if (step.then !== undefined && !ids.has(step.then)) {
      issues.push({
        code: "unknown_step_reference",
        stepId: step.id,
        message: `then references unknown step: ${step.then}`,
      });
    }
    if (step.of !== undefined && !ids.has(step.of)) {
      issues.push({
        code: "unknown_step_reference",
        stepId: step.id,
        message: `of references unknown step: ${step.of}`,
      });
    }
    checkTransition(step, "onFailure", ids, issues);
    checkTransition(step, "onChangesRequired", ids, issues);
  }

  const firstPublishIndex = steps.findIndex((step) => step.kind === "publish");
  if (firstPublishIndex >= 0) {
    const before = steps.slice(0, firstPublishIndex);
    const hasVerify = before.some((step) => step.kind === "verify");
    const hasReview = before.some((step) => step.kind === "review");
    if (!hasVerify || !hasReview) {
      issues.push({
        code: "publish_requires_verify_and_review",
        stepId: steps[firstPublishIndex]?.id,
        message: "publish requires both verify and review earlier in definition order",
      });
    }
  }

  steps.forEach((step, index) => {
    if (step.kind !== "implement") {
      return;
    }
    const hasVerifyAfter = steps.slice(index + 1).some((later) => later.kind === "verify");
    if (!hasVerifyAfter) {
      issues.push({
        code: "implement_requires_verify",
        stepId: step.id,
        message: "implement requires a verify step later in definition order",
      });
    }
  });

  steps.forEach((step, index) => {
    if (step.kind !== "discuss") {
      return;
    }
    const rest = steps.slice(index + 1);
    const gateIndex = rest.findIndex(
      (later) => later.kind === "implement" || later.kind === "fix" || later.kind === "publish",
    );
    const between = gateIndex >= 0 ? rest.slice(0, gateIndex) : rest;
    const approved = between.some(
      (later) => later.kind === "approve" && later.of === step.id,
    );
    if (!approved) {
      issues.push({
        code: "discuss_requires_approve",
        stepId: step.id,
        message: `discuss step ${step.id} requires an approve step with of: ${step.id} before implement/fix/publish`,
      });
    }
  });

  return issues;
}

export function assertValidWorkflowDefinition(definition: WorkflowDefinition): void {
  const issues = validateWorkflowDefinition(definition);
  if (issues.length > 0) {
    throw new WorkflowDefinitionError(issues);
  }
}
