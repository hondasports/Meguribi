import { describe, expect, it } from "vitest";
import { safeAgentEnvironment } from "../src/process.js";
import { redactText } from "../src/redaction.js";
import { assertSafeReadPath } from "../src/safety.js";

describe("redactText", () => {
  it("removes common credential formats without changing ordinary diagnostics", () => {
    const value = "token=cog_secret-value stderr=ok Bearer abc.def";
    const redacted = redactText(value);
    expect(redacted).not.toContain("cog_secret-value");
    expect(redacted).not.toContain("Bearer abc.def");
    expect(redacted).toContain("stderr=ok");
  });

  it("does not pass credential-like explicit environment variables to the child", () => {
    const environment = safeAgentEnvironment({ COGNITION_API_KEY: "secret", FAKE_ACP_MODE: "success" });
    expect(environment.COGNITION_API_KEY).toBeUndefined();
    expect(environment.FAKE_ACP_MODE).toBe("success");
  });

  it("rejects protected read paths", () => {
    expect(() => assertSafeReadPath("C:/fixture", ".env"))
      .toThrow("protected read path");
    expect(() => assertSafeReadPath("C:/fixture", ".git/config"))
      .toThrow("protected read path");
  });
});
