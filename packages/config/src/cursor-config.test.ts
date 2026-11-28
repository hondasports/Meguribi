import { describe, expect, it } from "vitest";
import { resolveCursorConfig } from "./cursor-config.js";

describe("resolveCursorConfig discussionMcpPolicy", () => {
  it.each([
    { configured: "warn", run: "allow", expected: "allow" },
    { configured: "warn", run: "deny", expected: "deny" },
    { configured: "allow", run: "deny", expected: "deny" },
    { configured: "deny", run: "allow", expected: "deny" },
  ] as const)(
    "resolves run-scoped discussion MCP policy before non-interactive validation ($configured + $run)",
    ({ configured, run, expected }) => {
      const sources = {
        nonInteractive: true,
        repository: { inheritedMcpPolicy: configured },
        discussionMcpPolicy: run,
      };

      expect(resolveCursorConfig(sources)).toMatchObject({ inheritedMcpPolicy: expected });
    },
  );

  it("keeps the legacy fail-closed warn validation when no run-scoped policy is selected", () => {
    expect(() => resolveCursorConfig({ nonInteractive: true })).toThrow(/inheritedMcpPolicy/);
  });
});
