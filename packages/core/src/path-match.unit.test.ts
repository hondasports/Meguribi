import { describe, expect, it } from "vitest";
import { matchesProtectedPath } from "./path-match.js";

describe("matchesProtectedPath", () => {
  it("matches trailing * on basename and nested segments", () => {
    expect(matchesProtectedPath(".env.local", [".env*"])).toBe(true);
    expect(matchesProtectedPath("config/.env.local", [".env*"])).toBe(true);
    expect(matchesProtectedPath("src/app.ts", [".env*"])).toBe(false);
  });

  it("matches **/middle*wildcard* patterns", () => {
    expect(matchesProtectedPath("config/app.secret.json", ["**/*secret*"])).toBe(true);
    expect(matchesProtectedPath("secret.env", ["**/*secret*"])).toBe(true);
    expect(matchesProtectedPath("src/app.ts", ["**/*secret*"])).toBe(false);
  });

  it("matches directory trees with /**", () => {
    expect(matchesProtectedPath(".github/workflows/ci.yml", [".github/**"])).toBe(true);
    expect(matchesProtectedPath(".github", [".github/**"])).toBe(true);
    expect(matchesProtectedPath("src/.github/x", [".github/**"])).toBe(false);
  });
});
