import { describe, expect, it } from "vitest";
import { parseDiscussionEnvelope } from "./envelope.js";

function envelopeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    message: "夜間通知はまとめるべきです",
    replyTo: ["t-1"],
    addressTo: ["codex"],
    positions: [{ issue: "通知タイミング", stance: "夜間はまとめる" }],
    newIssues: ["通知チャネル"],
    done: true,
    ...overrides,
  });
}

describe("parseDiscussionEnvelope", () => {
  it("uses the last json fence and applies schema defaults", () => {
    const text = [
      "first answer",
      "```json",
      JSON.stringify({ message: "first", done: false }),
      "```",
      "middle text",
      "```json",
      JSON.stringify({ message: "final" }),
      "```",
      "trailing text",
    ].join("\n");

    const result = parseDiscussionEnvelope(text);

    expect(result).toEqual({
      ok: true,
      envelope: {
        message: "final",
        replyTo: [],
        addressTo: [],
        positions: [],
        newIssues: [],
        done: false,
      },
    });
  });

  it("parses a complete envelope", () => {
    const result = parseDiscussionEnvelope(["```json", envelopeJson(), "```"].join("\n"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.done).toBe(true);
      expect(result.envelope.addressTo).toEqual(["codex"]);
      expect(result.envelope.positions).toEqual([
        { issue: "通知タイミング", stance: "夜間はまとめる" },
      ]);
    }
  });

  it("returns ok false with a reason when no valid JSON object exists", () => {
    const result = parseDiscussionEnvelope("no json here");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("json");
    }
  });

  it("returns ok false with a schema reason when the envelope is invalid", () => {
    const result = parseDiscussionEnvelope(
      ["```json", JSON.stringify({ replyTo: [] }), "```"].join("\n"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("message");
    }
  });
});
