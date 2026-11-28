export interface RunSelectionToken {
  runId: string;
  version: number;
}

export function isCurrentRunSelection(
  token: RunSelectionToken,
  selectedRunId: string | null,
  currentVersion: number,
): boolean {
  return token.runId === selectedRunId && token.version === currentVersion;
}
