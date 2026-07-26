import { describe, expect, it } from "vitest";
import { evaluatePublishGate, type ImplementationResult, type VerificationResult } from "@meguribi/core";
import type { ReviewArtifact } from "@meguribi/core";

function implementation(
  overrides: Partial<ImplementationResult> = {},
): ImplementationResult {
  return {
    status: "completed",
    sessionId: "s1",
    startedAt: "2026-07-26T12:00:00.000Z",
    finishedAt: "2026-07-26T12:01:00.000Z",
    durationMs: 60_000,
    changedFiles: ["src/a.ts"],
    reportedFiles: ["src/a.ts"],
    unresolvedItems: [],
    permissionDecisions: [],
    artifactPaths: { root: "/a" },
    publishable: true,
    ...overrides,
  };
}

function verification(success: boolean): VerificationResult {
  return {
    schemaVersion: 1,
    artifactType: "verification",
    success,
    commands: [
      {
        name: "test",
        exitCode: success ? 0 : 1,
        startedAt: "2026-07-26T12:00:00.000Z",
        finishedAt: "2026-07-26T12:00:01.000Z",
      },
    ],
  };
}

function review(status: ReviewArtifact["status"]): ReviewArtifact {
  return {
    schemaVersion: 1,
    artifactType: "code-review",
    status,
    summary: "review",
    requirementCoverage: [],
    findings: [],
    missingTests: [],
    scopeViolations: [],
    recommendedAction: status === "changes_required" ? "fix" : status === "blocked" ? "block" : "proceed",
    metadata: {
      schemaVersion: 1,
      artifactId: "r1",
      createdAt: "2026-07-26T12:00:00.000Z",
      durationMs: 1,
      producer: { kind: "codex", role: "reviewer", threadId: "t" },
      sourceDigests: {},
      eventLog: [],
    },
  };
}

describe("evaluatePublishGate", () => {
  it("allows publish when implementation, verification, and review are clean", () => {
    const decision = evaluatePublishGate({
      implementation: implementation(),
      verification: verification(true),
      review: review("approved"),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it("blocks when implementation is not publishable", () => {
    const decision = evaluatePublishGate({
      implementation: implementation({ publishable: false, status: "blocked" }),
      verification: verification(true),
      review: review("approved"),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/implementation status/),
        expect.stringMatching(/not publishable/),
      ]),
    );
  });

  it("blocks MCP policy, permission denied, cleanup, verify, and review failures", () => {
    const decision = evaluatePublishGate({
      implementation: implementation({
        mcpPolicyResult: {
          outcome: "block",
          reason: "mcp blocked",
          warning: "warn",
        },
        error: {
          code: "permission_denied",
          message: "denied",
          isRetryable: false,
        },
      }),
      verification: verification(false),
      review: review("changes_required"),
      cleanupFailed: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/MCP policy/),
        expect.stringMatching(/permission was denied/),
        expect.stringMatching(/cleanup failure/),
        expect.stringMatching(/verification failed/),
        expect.stringMatching(/requires changes/),
      ]),
    );
  });

  it("blocks when review status is blocked", () => {
    const decision = evaluatePublishGate({
      implementation: implementation(),
      verification: verification(true),
      review: review("blocked"),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.some((r) => /blocked publishing/i.test(r))).toBe(true);
  });

  it("blocks protected path changes", () => {
    const decision = evaluatePublishGate({
      implementation: implementation({ changedFiles: ["src/a.ts", ".env.local"] }),
      verification: verification(true),
      review: review("approved"),
      protectedPaths: [".env*"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.some((r) => /protected path/i.test(r))).toBe(true);
  });

  it("blocks **/secret* style protected paths", () => {
    const decision = evaluatePublishGate({
      implementation: implementation({ changedFiles: ["config/app.secret.json"] }),
      verification: verification(true),
      review: review("approved"),
      protectedPaths: ["**/*secret*"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.some((r) => /protected path/i.test(r))).toBe(true);
  });
});
