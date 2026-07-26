import type { ReviewArtifact, ReviewFinding } from "../codex-artifact.js";
import type { VerificationResult } from "../delivery.js";

/**
 * Codex analyzeFailure is not implemented yet.
 * Build a structured fix instruction from verification / review evidence instead.
 */
export function buildFixInstruction(input: {
  verification?: VerificationResult;
  review?: ReviewArtifact;
  previousSummary?: string;
}): { source: string; content: string } {
  const lines: string[] = [
    "Fix the previous implementation so Meguribi verification and review can pass.",
    "Do not commit, push, create PRs, or update Issues.",
  ];
  if (input.previousSummary) {
    lines.push("", "Previous attempt summary:", input.previousSummary);
  }
  if (input.verification && !input.verification.success) {
    lines.push("", "Verification failures:");
    for (const command of input.verification.commands) {
      if (command.exitCode !== 0) {
        lines.push(`- ${command.name}: exit ${String(command.exitCode)}`);
      }
    }
  }
  if (input.review && input.review.status === "changes_required") {
    lines.push("", "Review findings:");
    for (const finding of input.review.findings as ReviewFinding[]) {
      lines.push(`- [${finding.severity}] ${finding.problem}`);
      lines.push(`  Required: ${finding.requiredChange}`);
    }
  }
  return {
    source: "meguribi-fix-instruction",
    content: lines.join("\n"),
  };
}
