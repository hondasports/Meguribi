import { describe, expect, it } from "vitest";
import { createProgram } from "./program.js";

describe("CLI command registration", () => {
  it("registers the review command", () => {
    const program = createProgram();
    expect(program.commands.map((command) => command.name())).toContain("review");
  });

  it("registers the cleanup command", () => {
    const program = createProgram();
    expect(program.commands.map((command) => command.name())).toContain("cleanup");
  });
});
