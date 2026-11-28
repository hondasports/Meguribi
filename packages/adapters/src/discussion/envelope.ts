import type { DiscussionEnvelope } from "@meguribi/core";
import { DiscussionEnvelopeSchema } from "@meguribi/schemas";
import * as v from "valibot";
import { extractFinalJson } from "../role-planning/extract-json.js";

export type EnvelopeParseResult =
  | { ok: true; envelope: DiscussionEnvelope }
  | { ok: false; reason: string };

function validationSummary(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => issue.path?.map((item) => String(item.key)).join(".") ?? issue.message)
    .join(", ");
}

/**
 * 議論参加者の応答から封筒 JSON を取り出して検証する。
 * 最後の ```json フェンスを優先し、フェンスがなければ bare object を試す。
 */
export function parseDiscussionEnvelope(text: string): EnvelopeParseResult {
  const extracted = extractFinalJson(text);
  if (extracted === undefined) {
    return {
      ok: false,
      reason: "response did not contain a final ```json fence with valid JSON",
    };
  }

  const parsed = v.safeParse(DiscussionEnvelopeSchema, extracted);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `envelope schema mismatch: ${validationSummary(parsed.issues)}`,
    };
  }
  return { ok: true, envelope: parsed.output };
}
