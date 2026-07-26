import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  DevinDiagnosisSchema,
  DiagnosisErrorCodeSchema,
  DiagnosisWarningSchema,
} from "./devin-diagnosis.js";

const validDiagnosis = {
  executable: { status: "ok" as const, path: "/usr/bin/devin" },
  version: { status: "supported" as const, raw: "3000.2.17" },
  authentication: { status: "authenticated" as const },
  acp: { status: "supported" as const },
  inheritedMcpPolicy: "warn" as const,
  runnable: true,
  warnings: [
    {
      code: "inherited_mcp" as const,
      message: "Saved Devin settings may include MCP servers",
    },
  ],
  errors: [],
};

describe("DevinDiagnosisSchema", () => {
  it("parses and round-trips a valid diagnosis", () => {
    const parsed = v.parse(DevinDiagnosisSchema, validDiagnosis);
    const roundTrip = v.parse(DevinDiagnosisSchema, JSON.parse(JSON.stringify(parsed)));
    expect(roundTrip).toEqual(parsed);
  });

  it("accepts capability_missing as a diagnosis error code", () => {
    expect(v.parse(DiagnosisErrorCodeSchema, "capability_missing")).toBe("capability_missing");
    expect(v.parse(DiagnosisErrorCodeSchema, "unsupported_version")).toBe("unsupported_version");
  });

  it("rejects missing required fields", () => {
    const result = v.safeParse(DevinDiagnosisSchema, {
      executable: { status: "ok" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown warning codes", () => {
    const result = v.safeParse(DiagnosisWarningSchema, {
      code: "totally_made_up",
      message: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown inheritedMcpPolicy", () => {
    const result = v.safeParse(DevinDiagnosisSchema, {
      ...validDiagnosis,
      inheritedMcpPolicy: "quarantine",
    });
    expect(result.success).toBe(false);
  });
});
