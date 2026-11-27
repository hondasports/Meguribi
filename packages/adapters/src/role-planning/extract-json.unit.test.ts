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

  it("returns undefined for non-JSON text without a fence", () => {
    expect(extractFinalJson("plain text without fences")).toBeUndefined();
    expect(extractFinalJson("```\n{\"a\":1}\n```")).toBeUndefined();
  });

  it("falls back to the whole response when it is a bare JSON object", () => {
    expect(extractFinalJson('  {"a": 1, "b": [2]}  ')).toEqual({ a: 1, b: [2] });
  });

  it("returns undefined for fenceless JSON arrays or strings", () => {
    expect(extractFinalJson("[1, 2]")).toBeUndefined();
    expect(extractFinalJson('"just a string"')).toBeUndefined();
  });

  it("returns undefined for fenceless broken JSON", () => {
    expect(extractFinalJson('{"a": 1,')).toBeUndefined();
  });

  it("returns undefined for broken JSON in the last fence", () => {
    const text = "```json\n{\"a\": 1,\n```";
    expect(extractFinalJson(text)).toBeUndefined();
  });

  it("parses arrays and primitives inside the fence", () => {
    expect(extractFinalJson("```json\n[1, 2]\n```")).toEqual([1, 2]);
  });
});
