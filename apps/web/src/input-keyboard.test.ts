import { describe, expect, it } from "vitest";
import { shouldSubmitOnEnter } from "./input-keyboard.js";

describe("shouldSubmitOnEnter", () => {
  it("submits on Enter without Shift", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
  });

  it("keeps Shift+Enter available for a newline", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
  });

  it("does not submit while Japanese IME composition is active", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(
      shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }),
    ).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldSubmitOnEnter({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
  });
});
