/**
 * `cursor auth status` 出力から認証状態を判定する。
 * 認証情報そのものは読み取らない。
 */

export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

export function parseAuthStatus(input: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): AuthStatus {
  if (input.timedOut) {
    return "unknown";
  }
  const text = `${input.stdout}\n${input.stderr}`.toLowerCase();
  if (
    /\bunauthenticated\b/.test(text) ||
    /\bnot\s+logged\s+in\b/.test(text) ||
    /\bnot\s+authenticated\b/.test(text) ||
    /\blogin\s+required\b/.test(text)
  ) {
    return "unauthenticated";
  }
  // positive keyword は成功終了のときだけ信じる（fail-open 防止）
  if (input.exitCode === 0) {
    if (
      /\bauthenticated\b/.test(text) ||
      /\blogged\s+in\b/.test(text) ||
      /\blogged\s+in\s+as\b/.test(text)
    ) {
      return "authenticated";
    }
    // 成功終了でも明確な語がない場合は判定不能とする
    return "unknown";
  }
  if (input.exitCode !== null && input.exitCode !== 0) {
    // キーワード無しの異常終了は未認証と断定せず判定不能とする
    return "unknown";
  }
  return "unknown";
}
