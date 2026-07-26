import type {
  CodexArtifactMetadata,
  CodexEventRecord,
  PlanArtifact,
  PlanContent,
  ReviewArtifact,
  ReviewContent,
} from "@meguribi/core";
import {
  PlanArtifactSchema,
  PlanContentSchema,
  ReviewArtifactSchema,
  ReviewContentSchema,
} from "@meguribi/schemas";
import Ajv, { type ValidateFunction } from "ajv";
import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { digestSource } from "./digest.js";
import { buildPlanningPrompt, buildRepairPrompt, buildReviewPrompt } from "./prompt.js";
import { PlanContentJsonSchema, ReviewContentJsonSchema } from "./output-schema.js";
import { redactErrorMessage, toRedactedEventRecord } from "./redact.js";
import type {
  CodexAdapter,
  CodexAdapterOptions,
  CodexThread,
  CodexThreadEvent,
  PlanningInput,
  ReviewInput,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const ABORT_GRACE_MS = 5_000;
const ajv = new Ajv({ allErrors: true, strict: true });
const validatePlanContentJson = ajv.compile(PlanContentJsonSchema);
const validateReviewContentJson = ajv.compile(ReviewContentJsonSchema);

export class CodexAdapterError extends Error {
  constructor(
    public readonly code:
      | "malformed_message"
      | "timeout"
      | "cancelled"
      | "policy_blocked"
      | "process_crashed"
      | "unknown",
    message: string,
    public readonly isRetryable = false,
  ) {
    super(message);
    this.name = "CodexAdapterError";
  }
}

interface ExecutionResult {
  threadId: string;
  finalResponse: string;
  eventLog: CodexEventRecord[];
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= 2_147_483_647) {
    throw new CodexAdapterError(
      "unknown",
      "Codex timeout must be a positive integer below the Node.js timer limit",
    );
  }
}

function classifyError(error: unknown): CodexAdapterError {
  if (error instanceof CodexAdapterError) {
    return error;
  }
  if (error instanceof Error) {
    return new CodexAdapterError("process_crashed", redactErrorMessage(error.message), false);
  }
  return new CodexAdapterError("unknown", "Codex execution failed", false);
}

function validationSummary(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => issue.path?.map((item) => String(item.key)).join(".") ?? issue.message)
    .join(", ");
}

function jsonSchemaSummary(validator: ValidateFunction): string {
  return (validator.errors ?? [])
    .map((error) => `${error.instancePath || "<root>"} (${error.keyword})`)
    .join(", ");
}

function parseContent<T>(
  response: string,
  schema: v.GenericSchema<unknown, T>,
  jsonSchemaValidator: ValidateFunction,
): { success: true; output: T } | { success: false; message: string } {
  let value: unknown;
  try {
    value = JSON.parse(response);
  } catch {
    return { success: false, message: "response is not valid JSON" };
  }
  if (!jsonSchemaValidator(value)) {
    return {
      success: false,
      message: `response JSON Schema mismatch: ${jsonSchemaSummary(jsonSchemaValidator)}`,
    };
  }
  const result = v.safeParse(schema, value);
  if (!result.success) {
    return {
      success: false,
      message: `response schema mismatch: ${validationSummary(result.issues)}`,
    };
  }
  return { success: true, output: result.output };
}

function textFromEvent(event: CodexThreadEvent): string | undefined {
  if (event.type !== "item.completed" && event.type !== "item.updated") {
    return undefined;
  }
  const item = event.item;
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return undefined;
  }
  const itemRecord = item as Record<string, unknown>;
  return itemRecord.type === "agent_message" && typeof itemRecord.text === "string"
    ? itemRecord.text
    : undefined;
}

function threadIdFromEvent(event: CodexThreadEvent): string | undefined {
  return event.type === "thread.started" && typeof event.thread_id === "string"
    ? event.thread_id
    : undefined;
}

function eventError(event: CodexThreadEvent): string | undefined {
  if (event.type !== "turn.failed" && event.type !== "error") {
    return undefined;
  }
  const error = event.type === "error" ? event.message : event.error;
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    return typeof message === "string" ? message : "Codex returned an error event";
  }
  return "Codex returned an error event";
}

async function consumeTurn(
  thread: CodexThread,
  prompt: string,
  outputSchema: unknown,
  signal: AbortSignal,
  now: () => Date,
): Promise<ExecutionResult> {
  const streamed = await thread.runStreamed(prompt, { outputSchema, signal });
  const eventLog: CodexEventRecord[] = [];
  let threadId = thread.id ?? "";
  let finalResponse = "";
  let turnCompleted = false;
  for await (const event of streamed.events) {
    eventLog.push(toRedactedEventRecord(event, now().toISOString()));
    threadId = threadIdFromEvent(event) ?? threadId;
    finalResponse = textFromEvent(event) ?? finalResponse;
    turnCompleted = turnCompleted || event.type === "turn.completed";
    const message = eventError(event);
    if (message !== undefined) {
      throw new CodexAdapterError("process_crashed", redactErrorMessage(message), false);
    }
  }
  if (!threadId) {
    throw new CodexAdapterError("malformed_message", "Codex did not report a thread ID", false);
  }
  if (!finalResponse) {
    throw new CodexAdapterError(
      "malformed_message",
      "Codex returned an empty structured response",
      false,
    );
  }
  if (!turnCompleted) {
    throw new CodexAdapterError(
      "process_crashed",
      "Codex stream ended before turn completion",
      false,
    );
  }
  return { threadId, finalResponse, eventLog };
}

function makeThreadOptions(repositoryPath: string) {
  return {
    workingDirectory: repositoryPath,
    sandboxMode: "read-only" as const,
    networkAccessEnabled: false as const,
    webSearchEnabled: false as const,
    approvalPolicy: "never" as const,
  };
}

async function verifyWorkspace<T>(
  guard: PlanningInput["workspaceGuard"] | ReviewInput["workspaceGuard"],
  expectedDigest: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const before = await guard.snapshot();
  if (expectedDigest !== undefined && expectedDigest !== digestSource(before)) {
    throw new CodexAdapterError(
      "malformed_message",
      "Source digest mismatch for repository",
      false,
    );
  }
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  let after: string;
  try {
    after = await guard.snapshot();
  } catch (error) {
    throw new CodexAdapterError(
      "policy_blocked",
      `Unable to verify read-only workspace after Codex execution: ${redactErrorMessage(error instanceof Error ? error.message : "snapshot failed")}`,
      false,
    );
  }
  if (before !== after) {
    throw new CodexAdapterError(
      "policy_blocked",
      "Codex changed the read-only workspace; inspect the worktree before continuing",
      false,
    );
  }
  if (operationError !== undefined) {
    throw classifyError(operationError);
  }
  if (result === undefined) {
    throw new CodexAdapterError("unknown", "Codex adapter completed without an artifact", false);
  }
  return result;
}

async function waitForTask(task: Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ABORT_GRACE_MS);
  });
  const settled = task.then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([settled, grace]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function assertSourceDigest(
  name: string,
  value: unknown,
  sourceDigests: Record<string, string>,
): void {
  const expected = sourceDigests[name];
  if (expected === undefined) {
    throw new CodexAdapterError("malformed_message", `Missing source digest for ${name}`, false);
  }
  if (expected !== digestSource(value)) {
    throw new CodexAdapterError("malformed_message", `Source digest mismatch for ${name}`, false);
  }
}

function parseArtifact<T>(schema: v.GenericSchema<unknown, T>, value: unknown): T {
  const result = v.safeParse(schema, value);
  if (!result.success) {
    throw new CodexAdapterError(
      "malformed_message",
      `Generated artifact schema mismatch: ${validationSummary(result.issues)}`,
      false,
    );
  }
  return result.output;
}

export function createCodexAdapter(options: CodexAdapterOptions): CodexAdapter {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRepairAttempts = options.maxRepairAttempts ?? 1;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  assertTimeout(defaultTimeoutMs);
  if (maxRepairAttempts !== 0 && maxRepairAttempts !== 1) {
    throw new CodexAdapterError("unknown", "Codex repair attempts must be 0 or 1", false);
  }

  async function execute(
    thread: CodexThread,
    prompt: string,
    outputSchema: unknown,
    timeoutMs: number,
    abortSignal: AbortSignal | undefined,
  ): Promise<ExecutionResult> {
    assertTimeout(timeoutMs);
    if (abortSignal?.aborted) {
      throw new CodexAdapterError("cancelled", "Codex execution was cancelled before start", false);
    }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let removeAbortListener: (() => void) | undefined;
    let timedOut = false;
    let cancellationTriggered = false;
    let task: Promise<ExecutionResult>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(
          new CodexAdapterError("timeout", `Codex execution timed out after ${timeoutMs}ms`, true),
        );
      }, timeoutMs);
    });
    const cancellation = new Promise<never>((_, reject) => {
      if (abortSignal === undefined) {
        return;
      }
      const onAbort = () => {
        cancellationTriggered = true;
        controller.abort();
        reject(new CodexAdapterError("cancelled", "Codex execution was cancelled", false));
      };
      removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) {
        onAbort();
      }
    });
    task = cancellationTriggered
      ? Promise.reject(new CodexAdapterError("cancelled", "Codex execution was cancelled", false))
      : consumeTurn(thread, prompt, outputSchema, controller.signal, now);
    void task.catch(() => undefined);
    try {
      return await Promise.race([task, timeout, cancellation]);
    } catch (error) {
      const classified = timedOut
        ? new CodexAdapterError("timeout", `Codex execution timed out after ${timeoutMs}ms`, true)
        : cancellationTriggered || abortSignal?.aborted
          ? new CodexAdapterError("cancelled", "Codex execution was cancelled", false)
          : classifyError(error);
      if (timedOut || cancellationTriggered || abortSignal?.aborted) {
        if (!(await waitForTask(task))) {
          throw new CodexAdapterError(
            "process_crashed",
            "Codex turn did not terminate after cancellation; inspect the process before continuing",
            false,
          );
        }
      }
      throw classified;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      removeAbortListener?.();
    }
  }

  async function runStructured<T extends PlanContent | ReviewContent>(input: {
    role: "planner" | "reviewer";
    repositoryPath: string;
    threadId?: string;
    prompt: string;
    schema: v.GenericSchema<unknown, T>;
    outputSchema: unknown;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<{ content: T; threadId: string; eventLog: CodexEventRecord[]; durationMs: number }> {
    const startedAt = Date.now();
    const threadOptions = makeThreadOptions(input.repositoryPath);
    const thread =
      input.threadId === undefined
        ? options.client.startThread(threadOptions)
        : options.client.resumeThread(input.threadId, threadOptions);
    let prompt = input.prompt;
    let eventLog: CodexEventRecord[] = [];
    let threadId = thread.id ?? input.threadId ?? "";
    let lastValidationMessage = "response did not match the required schema";
    for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
      const execution = await execute(
        thread,
        prompt,
        input.outputSchema,
        input.timeoutMs ?? defaultTimeoutMs,
        input.abortSignal,
      );
      eventLog = [...eventLog, ...execution.eventLog];
      threadId = execution.threadId;
      const parsed = parseContent(
        execution.finalResponse,
        input.schema,
        input.role === "planner" ? validatePlanContentJson : validateReviewContentJson,
      );
      if (parsed.success) {
        return {
          content: parsed.output,
          threadId,
          eventLog,
          durationMs: Date.now() - startedAt,
        };
      }
      lastValidationMessage = parsed.message;
      if (attempt === maxRepairAttempts) {
        throw new CodexAdapterError("malformed_message", lastValidationMessage, false);
      }
      prompt = buildRepairPrompt(input.role, lastValidationMessage);
    }
    throw new CodexAdapterError("malformed_message", lastValidationMessage, false);
  }

  async function createPlan(input: PlanningInput): Promise<PlanArtifact> {
    assertSourceDigest("issue", input.issue, input.sourceDigests);
    const execution = await verifyWorkspace(
      input.workspaceGuard,
      input.sourceDigests.repository,
      async () => {
        const result = await runStructured({
          role: "planner",
          repositoryPath: input.repositoryPath,
          threadId: input.threadId,
          prompt: buildPlanningPrompt(input),
          schema: PlanContentSchema,
          outputSchema: PlanContentJsonSchema,
          timeoutMs: input.timeoutMs,
          abortSignal: input.abortSignal,
        });
        return parseArtifact(PlanArtifactSchema, {
          ...result.content,
          schemaVersion: 1 as const,
          artifactType: "implementation-plan" as const,
          metadata: makeMetadata("planner", result, input.sourceDigests),
        });
      },
    );
    return execution;
  }

  async function review(input: ReviewInput): Promise<ReviewArtifact> {
    assertSourceDigest("issue", input.issue, input.sourceDigests);
    assertSourceDigest("plan", input.plan, input.sourceDigests);
    assertSourceDigest("diff", input.diff, input.sourceDigests);
    assertSourceDigest("verification", input.verification, input.sourceDigests);
    const execution = await verifyWorkspace(
      input.workspaceGuard,
      input.sourceDigests.repository,
      async () => {
        const result = await runStructured({
          role: "reviewer",
          repositoryPath: input.repositoryPath,
          threadId: input.threadId,
          prompt: buildReviewPrompt(input),
          schema: ReviewContentSchema,
          outputSchema: ReviewContentJsonSchema,
          timeoutMs: input.timeoutMs,
          abortSignal: input.abortSignal,
        });
        return parseArtifact(ReviewArtifactSchema, {
          ...result.content,
          schemaVersion: 1 as const,
          artifactType: "code-review" as const,
          metadata: makeMetadata("reviewer", result, input.sourceDigests),
        });
      },
    );
    return execution;
  }

  function makeMetadata(
    role: "planner" | "reviewer",
    result: { threadId: string; eventLog: CodexEventRecord[]; durationMs: number },
    sourceDigests: Record<string, string>,
  ): CodexArtifactMetadata {
    return {
      schemaVersion: 1,
      artifactId: idFactory(),
      createdAt: now().toISOString(),
      durationMs: result.durationMs,
      producer: { kind: "codex", role, threadId: result.threadId },
      sourceDigests: { ...sourceDigests },
      eventLog: result.eventLog,
    };
  }

  return { createPlan, review };
}
