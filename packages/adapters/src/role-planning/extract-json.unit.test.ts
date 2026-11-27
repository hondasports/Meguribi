import { describe, expect, it } from "vitest";
import { extractFinalJson } from "./extract-json.js";

describe("extractFinalJson", () => {
  it("returns the last json fence when multiple are present", () => {
    const text = [
      "some explanation",
      "```json",
      '{"a": 1}',
      "```",
      "more text",
      "```json",
      '{"b": 2}',
      "```",
      "trailing",
    ].join("\n");
    expect(extractFinalJson(text)).toEqual({ b: 2 });
  });

  it("returns undefined when there is no json fence", () => {
    expect(extractFinalJson("plain text without fences")).toBeUndefined();
    expect(extractFinalJson("```\n{\"a\":1}\n```")).toBeUndefined();
  });

  it("returns undefined for broken JSON in the last fence", () => {
    const text = "```json\n{\"a\": 1,\n```";
    expect(extractFinalJson(text)).toBeUndefined();
  });

  it("parses arrays and primitives inside the fence", () => {
    expect(extractFinalJson("```json\n[1, 2]\n```")).toEqual([1, 2]);
  });
});
