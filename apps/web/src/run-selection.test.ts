import { describe, expect, it } from "vitest";
import { isCurrentRunSelection } from "./run-selection.js";

describe("run selection guard", () => {
  it("accepts only the latest selection token for the selected run", () => {
    const token = { runId: "run-a", version: 2 };
    expect(isCurrentRunSelection(token, "run-a", 2)).toBe(true);
    expect(isCurrentRunSelection(token, "run-b", 2)).toBe(false);
    expect(isCurrentRunSelection(token, "run-a", 3)).toBe(false);
  });
});
