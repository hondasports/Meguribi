import { createHash } from "node:crypto";
import type {
  DiscussionConclusion,
  DiscussionConclusionContent,
  DiscussionEndReason,
  DiscussionTurn,
  RoleSession,
  SummarizeDiscussionInput,
} from "@meguribi/core";
import { agentDisplayName } from "@meguribi/core";
import { DiscussionConclusionContentSchema } from "@meguribi/schemas";
import * as v from "valibot";
import { RoleSessionWriteViolationError } from "../acp-server/role-agent.js";
import { extractFinalJson } from "../role-planning/extract-json.js";
import { RolePlanningError } from "../role-planning/bridge.js";
import { buildRoleRepairPrompt } from "../role-planning/repair-prompt.js";

const CONCLUSION_KEYS = [
  "topic",
  "conclusion",
  "issues",
  "rejectedOptions",
  "openQuestions",
  "acceptanceCriteriaSeeds",
] as const;

export interface SummarizeDiscussionPromptInput {
  brief: SummarizeDiscussionInput["brief"];
  transcript: readonly DiscussionTurn[];
  endedBy: DiscussionEndReason;
}

export type SummarizeDiscussionPromptBuilder = (
  input: SummarizeDiscussionPromptInput,
) => string;

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function hashTranscript(turns: readonly DiscussionTurn[]): string {
  return sha256Json(turns);
}

export function hashConclusion(conclusion: DiscussionConclusion): string {
  return sha256Json(conclusion);
}

function validationSummary(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => issue.path?.map((item) => String(item.key)).join(".") ?? issue.message)
    .join(", ");
}

function unknownTurnIds(
  content: DiscussionConclusionContent,
  turns: readonly DiscussionTurn[],
): string[] {
  const known = new Set(turns.map((turn) => turn.turnId));
  const referenced: string[] = [];
  for (const issue of content.issues) {
    for (const position of issue.positions) {
      referenced.push(...position.turnIds);
    }
  }
  for (const option of content.rejectedOptions) {
    referenced.push(...option.turnIds);
  }
  return [...new Set(referenced.filter((turnId) => !known.has(turnId)))].sort();
}

function validateConclusionContent(
  text: string,
  turns: readonly DiscussionTurn[],
): { ok: true; content: DiscussionConclusionContent } | { ok: false; reason: string } {
  const extracted = extractFinalJson(text);
  if (extracted === undefined) {
    return {
      ok: false,
      reason: "response did not contain a final ```json fence with valid JSON",
    };
  }

  const parsed = v.safeParse(DiscussionConclusionContentSchema, extracted);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `response schema mismatch: ${validationSummary(parsed.issues)}`,
    };
  }

  const unknownIds = unknownTurnIds(parsed.output, turns);
  if (unknownIds.length > 0) {
    return {
      ok: false,
      reason: `turnIds must reference existing transcript turns; unknown: ${unknownIds.join(", ")}`,
    };
  }
  return { ok: true, content: parsed.output };
}

/**
 * summarizer を read-only で呼び出し、結論 JSON を最大2回再要求して検証する。
 * buildPrompt は Task 3 の buildSummarizerPrompt 統合まで外部から注入する。
 */
export async function summarizeDiscussion(
  input: SummarizeDiscussionInput,
  buildPrompt: SummarizeDiscussionPromptBuilder,
): Promise<DiscussionConclusion> {
  let prompt = buildPrompt({
    brief: input.brief,
    transcript: input.turns,
    endedBy: input.endedBy,
  });
  const session = await input.summarizer.openSession({
    cwd: input.cwd,
    mode: "read-only",
    role: "summarizer",
    artifactRoot: input.artifactRoot,
    onEvent: input.onEvent
      ? (event) => {
          input.onEvent?.({
            type: "agent.event",
            stepId: "discuss",
            profileId: input.summarizer.profileId,
            agentLabel: agentDisplayName(input.summarizer.kind),
            role: "summarizer",
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
      const result = await sendWithConversion(session, prompt, attempts);
      const validated = validateConclusionContent(result.text, input.turns);
      if (validated.ok) {
        return {
          ...validated.content,
          endedBy: input.endedBy,
          transcriptHash: hashTranscript(input.turns),
        };
      }
      lastMessage = validated.reason;
      if (attempts < 3) {
        prompt = buildRoleRepairPrompt("summarizer", lastMessage, CONCLUSION_KEYS);
      }
    }
    throw new RolePlanningError(
      "malformed_output",
      `summarizer response failed validation after ${attempts} attempts: ${lastMessage}`,
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
): Promise<{ text: string }> {
  try {
    return await session.send({ content });
  } catch (error) {
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
