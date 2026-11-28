import type {
  DiscussionConclusion,
  LiveLogEvent,
  RoleAgent,
  RoleSession,
  SpecificationContent,
  SpecificationPromptInput,
} from "@meguribi/core";
import {
  agentDisplayName,
  buildSpecificationRepairPrompt,
} from "@meguribi/core";
import { SpecificationContentSchema } from "@meguribi/schemas";
import * as v from "valibot";
import { RoleSessionWriteViolationError } from "../acp-server/role-agent.js";
import { extractFinalJson } from "../role-planning/extract-json.js";
import { RolePlanningError } from "../role-planning/bridge.js";

const CONTENT_KEYS = [
  "problem",
  "targetUsers",
  "requirements",
  "acceptanceCriteria",
  "inScope",
  "outOfScope",
  "testPlan",
  "successMetrics",
  "guardrails",
  "openQuestions",
] as const;

export interface SpecifyApprovedConclusionInput {
  specifier: RoleAgent;
  cwd: string;
  artifactRoot: string;
  conclusion: DiscussionConclusion;
  abortSignal?: AbortSignal;
  onEvent?: (event: LiveLogEvent) => void;
}

export type SpecificationPromptBuilder = (input: SpecificationPromptInput) => string;

function validationSummary(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => issue.path?.map((item) => String(item.key)).join(".") ?? issue.message)
    .join(", ");
}

function specifierCancelledError(): Error & { code: "cancelled" } {
  const error = new Error("specifier cancelled") as Error & { code: "cancelled" };
  error.code = "cancelled";
  return error;
}

async function withAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return await operation();
  }
  let rejectAborted!: (error: Error & { code: "cancelled" }) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => {
    rejectAborted(specifierCancelledError());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    const result = await Promise.race([operation(), aborted]);
    if (signal.aborted) {
      throw specifierCancelledError();
    }
    return result;
  } catch (error) {
    if (signal.aborted) {
      throw specifierCancelledError();
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function validateContent(
  text: string,
): { ok: true; content: SpecificationContent } | { ok: false; reason: string } {
  const extracted = extractFinalJson(text);
  if (extracted === undefined) {
    return {
      ok: false,
      reason: "response did not contain a final ```json fence with valid JSON",
    };
  }
  const parsed = v.safeParse(SpecificationContentSchema, extracted);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `response schema mismatch: ${validationSummary(parsed.issues)}`,
    };
  }
  return { ok: true, content: parsed.output };
}

export async function specifyApprovedConclusion(
  input: SpecifyApprovedConclusionInput,
  buildPrompt: SpecificationPromptBuilder,
): Promise<SpecificationContent> {
  let prompt = buildPrompt({ conclusion: input.conclusion });
  const session = await input.specifier.openSession({
    cwd: input.cwd,
    mode: "read-only",
    role: "specifier",
    artifactRoot: input.artifactRoot,
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    onEvent: input.onEvent
      ? (event) => {
          input.onEvent?.({
            type: "agent.event",
            stepId: "specify",
            profileId: input.specifier.profileId,
            agentLabel: agentDisplayName(input.specifier.kind),
            role: "specifier",
            event,
          });
        }
      : undefined,
  });

  let attempts = 0;
  try {
    let lastMessage = "response did not match the required schema";
    while (attempts < 3) {
      attempts += 1;
      const result = await sendWithConversion(session, prompt, attempts, input.abortSignal);
      const validated = validateContent(result.text);
      if (validated.ok) {
        if (input.abortSignal?.aborted) {
          throw specifierCancelledError();
        }
        return validated.content;
      }
      lastMessage = validated.reason;
      if (attempts < 3) {
        prompt = buildSpecificationRepairPrompt(lastMessage, CONTENT_KEYS);
      }
    }
    throw new RolePlanningError(
      "malformed_output",
      `specifier response failed validation after ${attempts} attempts: ${lastMessage}`,
      attempts,
    );
  } finally {
    await closeWithConversion(session, attempts);
  }
}

async function sendWithConversion(
  session: RoleSession,
  content: string,
  attempts: number,
  abortSignal: AbortSignal | undefined,
): Promise<{ text: string }> {
  try {
    return await withAbort(() => session.send({ content }), abortSignal);
  } catch (error) {
    if (abortSignal?.aborted) {
      throw specifierCancelledError();
    }
    throw convertRoleSessionError(error, attempts);
  }
}

async function closeWithConversion(session: RoleSession, attempts: number): Promise<void> {
  try {
    await session.close();
  } catch (error) {
    throw convertRoleSessionError(error, attempts);
  }
}

function convertRoleSessionError(error: unknown, attempts: number): unknown {
  if (error instanceof RoleSessionWriteViolationError) {
    return new RolePlanningError(
      "policy_blocked",
      `${error.message} (changed files: ${error.changedFiles.join(", ")})`,
      attempts,
    );
  }
  return error;
}
