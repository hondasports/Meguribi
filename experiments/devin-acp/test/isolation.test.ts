import { describe, expect, it } from "vitest";
import { buildIsolatedEnvironment, configSourcePath, CONFIG_SOURCE_ORDER } from "../src/isolation.js";

describe("MCP isolation", () => {
  it("creates independent config roots without forwarding credential variables", () => {
    const isolation = buildIsolatedEnvironment("C:/artifacts/run", {
      COGNITION_API_KEY: "must-not-pass",
      PATH: "C:/safe/path"
    });

    expect(isolation.env.COGNITION_API_KEY).toBeUndefined();
    expect(isolation.env.PATH).toBe("C:/safe/path");
    expect(isolation.env.HOME?.replaceAll("\\", "/")).toContain("C:/artifacts/run");
    expect(isolation.env.USERPROFILE?.replaceAll("\\", "/")).toContain("C:/artifacts/run");
    expect(isolation.env.APPDATA?.replaceAll("\\", "/")).toContain("C:/artifacts/run");
    expect(isolation.env.XDG_CONFIG_HOME?.replaceAll("\\", "/")).toContain("C:/artifacts/run");
  });

  it("uses the documented configuration source order", () => {
    expect(CONFIG_SOURCE_ORDER).toEqual(["user", "project", "local", "cli"]);
    expect(configSourcePath("C:/fixture", "project")).toBe("C:/fixture/.devin/config.json");
    expect(configSourcePath("C:/fixture", "local")).toBe("C:/fixture/.devin/config.local.json");
  });
});
