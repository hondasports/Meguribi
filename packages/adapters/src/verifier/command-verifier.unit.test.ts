import { describe, expect, it } from "vitest";
import { parseVerifyCommand } from "./command-verifier.js";

describe("parseVerifyCommand", () => {
  it("splits simple pnpm commands", () => {
    expect(parseVerifyCommand("pnpm test")).toEqual({
      executable: "pnpm",
      args: ["test"],
    });
  });

  it("rejects shell metacharacters", () => {
    expect(() => parseVerifyCommand("pnpm test & calc.exe")).toThrow(/metacharacters/i);
    expect(() => parseVerifyCommand("pnpm test | cat")).toThrow(/metacharacters/i);
    expect(() => parseVerifyCommand("pnpm test > out.txt")).toThrow(/metacharacters/i);
  });
});
