import type { DevinDiagnosis } from "@meguribi/core";
import { sanitizeDiagnosticDisplayText } from "./redact.js";

/**
 * `meguribi doctor` 向けの人間可読表示。
 */
export function formatDevinDiagnosisHuman(diagnosis: DevinDiagnosis): string {
  const lines: string[] = [];

  if (diagnosis.executable.status === "missing") {
    lines.push("✗ Devin CLI: missing");
  } else if (diagnosis.version.raw) {
    const mark =
      diagnosis.version.status === "unsupported"
        ? "✗"
        : diagnosis.version.status === "unknown"
          ? "!"
          : "✓";
    lines.push(`${mark} Devin CLI: ${sanitizeDiagnosticDisplayText(diagnosis.version.raw)}`);
  } else {
    lines.push("! Devin CLI: version unknown");
  }

  const authMark =
    diagnosis.authentication.status === "authenticated"
      ? "✓"
      : diagnosis.authentication.status === "unauthenticated"
        ? "✗"
        : "!";
  lines.push(`${authMark} Authentication: ${diagnosis.authentication.status}`);

  const acpMark =
    diagnosis.acp.status === "supported"
      ? "✓"
      : diagnosis.acp.status === "unsupported"
        ? "✗"
        : "!";
  lines.push(`${acpMark} ACP: ${diagnosis.acp.status}`);

  const mcpWarning = diagnosis.warnings.find((warning) => warning.code === "inherited_mcp");
  if (mcpWarning) {
    lines.push(`! ${sanitizeDiagnosticDisplayText(mcpWarning.message)}`);
    lines.push(`  Policy: ${diagnosis.inheritedMcpPolicy}`);
  }

  for (const error of diagnosis.errors) {
    lines.push(`✗ ${sanitizeDiagnosticDisplayText(error.message)}`);
    if (error.nextAction) {
      lines.push(`  Next: ${sanitizeDiagnosticDisplayText(error.nextAction)}`);
    }
  }

  for (const warning of diagnosis.warnings) {
    if (warning.code === "inherited_mcp") {
      continue;
    }
    lines.push(`! ${sanitizeDiagnosticDisplayText(warning.message)}`);
  }

  lines.push(diagnosis.runnable ? "Runnable: yes" : "Runnable: no");
  return `${lines.join("\n")}\n`;
}
