/**
 * Cursor CLI の help 出力から ACP 対応を判定する。
 * session やネットワーク接続は開始しない。
 */

export type AcpStatus = "supported" | "unsupported" | "unknown";

export function parseAcpCapability(input: {
  rootHelp?: string;
  rootHelpExitCode?: number | null;
  acpHelp: string;
  acpExitCode: number | null;
  timedOut?: boolean;
}): AcpStatus {
  if (input.timedOut) {
    return "unknown";
  }

  // exitCode === 0 のときだけ成功扱い。null（signal）や非ゼロは成功にしない。
  if (input.acpExitCode !== 0) {
    const text = input.acpHelp.toLowerCase();
    if (
      /unknown\s+command/.test(text) ||
      /invalid\s+command/.test(text) ||
      /not\s+found/.test(text)
    ) {
      return "unsupported";
    }
    return "unknown";
  }

  const acpHelp = input.acpHelp;
  const hasUsage = /usage:\s*cursor(?:\.exe)?\s+acp\b/i.test(acpHelp);
  const mentionsAcp = /\bacp\b/i.test(acpHelp);
  if (hasUsage || (mentionsAcp && /stdio|agent\s*client|initialize/i.test(acpHelp))) {
    return "supported";
  }

  const rootOk = input.rootHelpExitCode === 0 && input.rootHelp !== undefined;
  if (rootOk) {
    const rootMentionsAcp =
      /\bacp\b/i.test(input.rootHelp!) && /usage:\s*cursor(?:\.exe)?\s+acp/i.test(input.rootHelp!);
    if (rootMentionsAcp && mentionsAcp) {
      return "supported";
    }
  }

  if (!mentionsAcp) {
    return "unsupported";
  }
  return "unknown";
}
