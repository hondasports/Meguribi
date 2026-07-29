export const PlanContentJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    requirements: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    outOfScope: { type: "array", items: { type: "string" } },
    proposedFiles: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    tests: { type: "array", items: { type: "string" } },
    humanDecisions: { type: "array", items: { type: "string" } },
    unresolvedItems: { type: "array", items: { type: "string" } },
  },
  required: [
    "summary",
    "requirements",
    "acceptanceCriteria",
    "outOfScope",
    "proposedFiles",
    "steps",
    "risks",
    "tests",
    "humanDecisions",
    "unresolvedItems",
  ],
} as const;

export const ReviewContentJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["approved", "approved_with_notes", "changes_required", "blocked"],
    },
    summary: { type: "string" },
    requirementCoverage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          requirementId: { type: "string" },
          status: { type: "string", enum: ["covered", "partial", "missing"] },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["requirementId", "status", "evidence"],
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          path: { anyOf: [{ type: "string" }, { type: "null" }] },
          line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
          problem: { type: "string" },
          requiredChange: { type: "string" },
        },
        required: ["id", "severity", "path", "line", "problem", "requiredChange"],
      },
    },
    missingTests: { type: "array", items: { type: "string" } },
    scopeViolations: { type: "array", items: { type: "string" } },
    recommendedAction: { type: "string", enum: ["proceed", "fix", "block"] },
  },
  required: [
    "status",
    "summary",
    "requirementCoverage",
    "findings",
    "missingTests",
    "scopeViolations",
    "recommendedAction",
  ],
} as const;
