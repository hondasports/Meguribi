import { describe, expect, it } from "vitest";
import { parseAuthStatus } from "./auth.js";

describe("parseAuthStatus", () => {
  it("detects authenticated on exit 0 with a positive keyword", () => {
    expect(
      parseAuthStatus({ exitCode: 0, stdout: "Logged in as alice", stderr: "" }),
    ).toBe("authenticated");
    expect(
      parseAuthStatus({ exitCode: 0, stdout: "Authenticated", stderr: "" }),
    ).toBe("authenticated");
    expect(
      parseAuthStatus({ exitCode: 0, stdout: "you are logged in", stderr: "" }),
    ).toBe("authenticated");
  });

  it("detects unauthenticated from negative keywords", () => {
    expect(
      parseAuthStatus({ exitCode: 1, stdout: "Unauthenticated", stderr: "" }),
    ).toBe("unauthenticated");
    expect(
      parseAuthStatus({
        exitCode: 1,
        stdout: "Error: not logged in",
        stderr: "",
      }),
    ).toBe("unauthenticated");
    expect(
      parseAuthStatus({
        exitCode: 0,
        stdout: "not authenticated",
        stderr: "",
      }),
    ).toBe("unauthenticated");
    expect(
      parseAuthStatus({ exitCode: 0, stdout: "login required", stderr: "" }),
    ).toBe("unauthenticated");
  });

  it("returns unknown on timeout", () => {
    expect(
      parseAuthStatus({
        exitCode: 0,
        stdout: "Authenticated",
        stderr: "",
        timedOut: true,
      }),
    ).toBe("unknown");
  });

  it("returns unknown when exit 0 has no recognizable keyword", () => {
    expect(parseAuthStatus({ exitCode: 0, stdout: "OK", stderr: "" })).toBe(
      "unknown",
    );
  });

  it("does not trust a positive keyword on non-zero exit", () => {
    expect(
      parseAuthStatus({ exitCode: 1, stdout: "authenticated", stderr: "" }),
    ).toBe("unknown");
  });

  it("returns unknown on non-zero exit without a negative keyword", () => {
    expect(
      parseAuthStatus({
        exitCode: 127,
        stdout: "",
        stderr: "command not found",
      }),
    ).toBe("unknown");
  });
});
