import { randomUUID } from "node:crypto";
import {
  ProcessError,
  ProcessRunner,
  type ManagedProcess,
} from "@meguribi/process";
import type {
  AgentDiagnosis,
  AgentEvent,
  AgentProfile,
  AgentPrompt,
  AgentTurnResult,
  InheritedMcpPolicy,
  OpenRoleSessionInput,
  RoleAgent,
  RoleSession,
} from "@meguribi/core";
import { captureGitWorktreeSnapshot, type GitWorktreeSnapshot } from "../git-boundary.js";
import { RoleSessionWriteViolationError } from "../acp-server/role-agent.js";
import { createMcpPolicyMonitor, formatMcpSecurityAlert } from "../acp/mcp.js";
import { redactErrorMessage } from "./redact.js";

/**
 * discussion deny 時にユーザーの Codex 設定（MCP サーバー含む）を構造的に
 * 継承しない native `codex exec` ベースの RoleAgent。
 *
 * - `--ignore-user-config`: `$CODEX_HOME/config.toml` を読まない。
 *   認証は引き続き CODEX_HOME 側の auth が使われる（codex 本体の仕様）。
 *   プロジェクト側 `.codex/config.toml` はこのフラグの対象外なので、
 *   残存リスクとして stderr の MCP 起動証拠を検知して terminate する安全網を持つ。
 * - `--ephemeral`: セッション永続化をしない。
 * - `--sandbox read-only`: discussant の read-only 役割を OS レベルで強制する。
 *   加えて ACP 経路と同じ git snapshot guard を send/close 後に適用する。
 *
 * 議論ターンのプロンプトは transcript を含む自己完結形なので、
 * 各 send を独立した exec invocation として実行してよい。
 */

export class CodexExecError extends Error {
  constructor(
    public readonly code:
      | "timeout"
      | "cancelled"
      | "process_crashed"
      | "turn_failed"
      | "spawn_failure"
      | "policy_blocked"
      | "malformed_message",
    message: string,
  ) {
    super(message);
    this.name = "CodexExecError";
  }
}

export interface CreateCodexExecRoleAgentOptions {
  profile: AgentProfile;
  /** codex CLI の executable。既定は PATH 上の `codex`。 */
  executable?: string;
  /** node wrapper 等を使う場合に executable の直後へ置く引数。 */
  executableArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
  /** テスト用に snapshot 取得を差し替える。既定は git worktree の実スナップショット。 */
  captureSnapshot?: (input: { cwd: string }) => Promise<GitWorktreeSnapshot>;
  /** 監視ポリシーの明示上書き。既定は profile.inheritedMcpPolicy。 */
  mcpPolicy?: InheritedMcpPolicy;
}

const EXEC_ARGS = [
  "exec",
  "--ignore-user-config",
  "--ephemeral",
  "--sandbox",
  "read-only",
  "--json",
] as const;

const TERMINATION_GRACE_MS = 2_000;
const MAX_STDERR_TAIL = 4_000;

interface ExecJsonEvent {
  type?: string;
  thread_id?: string;
  usage?: unknown;
  stop_reason?: string;
  message?: string;
  error?: { message?: string };
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
}

function parseJsonLine(line: string): ExecJsonEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as ExecJsonEvent;
    }
  } catch {
    // JSONL でない行（進捗表示など）は無視する。
  }
  return undefined;
}

function snapshotViolation(
  before: GitWorktreeSnapshot,
  after: GitWorktreeSnapshot,
): RoleSessionWriteViolationError | undefined {
  const changed = new Set<string>();
  const collect = (
    beforeEntries: Readonly<Record<string, string>>,
    afterEntries: Readonly<Record<string, string>>,
  ) => {
    for (const key of new Set([...Object.keys(beforeEntries), ...Object.keys(afterEntries)])) {
      if (beforeEntries[key] !== afterEntries[key]) changed.add(key);
    }
  };
  collect(before.statusEntries, after.statusEntries);
  collect(before.fileDigests, after.fileDigests);
  if (before.head !== after.head || changed.size > 0) {
    return new RoleSessionWriteViolationError([...changed].sort());
  }
  return undefined;
}

function toCodexExecError(error: ProcessError): CodexExecError {
  if (error.code === "timeout") {
    return new CodexExecError("timeout", "codex exec turn timed out");
  }
  if (error.code === "cancelled") {
    return new CodexExecError("cancelled", "codex exec turn was cancelled");
  }
  if (error.code === "executable_not_found") {
    return new CodexExecError(
      "spawn_failure",
      `Codex CLI executable not found. Install the Codex CLI and ensure \`codex\` is on PATH`,
    );
  }
  return new CodexExecError(
    "process_crashed",
    redactErrorMessage(error.message ?? "codex exec failed"),
  );
}

class CodexExecRoleSession implements RoleSession {
  readonly sessionId: string;
  private closed = false;
  private active: ManagedProcess | undefined;
  /**
   * 成功したターンの user prompt と assistant 返答の履歴。
   * native exec は毎回別プロセスで前の文脈を持たないため、room.ts が
   * sinceTurnIndex 以降の増分だけを渡す議論では前の発言が見えなくなる。
   * 成功した send だけを順序立てて保持し、次の exec 入力へ role 境界付きで前置する。
   * エラーになったターンは含めず、close で破棄する。セッションをまたいで共有しない。
   */
  private readonly history: { role: "user" | "assistant"; content: string }[] = [];

  constructor(
    private readonly options: CreateCodexExecRoleAgentOptions,
    private readonly input: OpenRoleSessionInput,
    private readonly before: GitWorktreeSnapshot | undefined,
  ) {
    this.sessionId = `codex-exec-${randomUUID()}`;
  }

  async send(prompt: AgentPrompt): Promise<AgentTurnResult> {
    if (this.closed) {
      throw new CodexExecError("cancelled", "Codex exec session is already closed");
    }
    const result = await this.runTurn(prompt);
    await this.assertUnmodified();
    // ここまで例外なく完了したターンだけを履歴に残す。guard 失敗や exec 失敗は残さない。
    this.history.push(
      { role: "user", content: prompt.content },
      { role: "assistant", content: result.text },
    );
    return result;
  }

  /**
   * 初回はプロンプトをそのまま渡す。2回目以降は成功済みの履歴を
   * JSON.stringify した構造で前置し、本文中のマーカー文字列では role を偽装できないようにする。
   */
  private composeInput(promptContent: string): string {
    if (this.history.length === 0) {
      return promptContent;
    }
    return [
      "[CONVERSATION HISTORY]",
      "The past turns of this session as a JSON array of { role, content } in chronological order. Use them as context for your response.",
      JSON.stringify(this.history),
      "",
      "[CURRENT INPUT]",
      promptContent,
    ].join("\n");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.history.length = 0;
    const active = this.active;
    if (active) {
      await active.terminateTree({ graceMs: TERMINATION_GRACE_MS }).catch(() => undefined);
    }
    await this.assertUnmodified();
  }

  private async assertUnmodified(): Promise<void> {
    if (!this.before) return;
    const capture = this.options.captureSnapshot ?? captureGitWorktreeSnapshot;
    const after = await capture({ cwd: this.input.cwd });
    const violation = snapshotViolation(this.before, after);
    if (violation) throw violation;
  }

  private async runTurn(prompt: AgentPrompt): Promise<AgentTurnResult> {
    const executable = this.options.executable ?? "codex";
    const runner = this.options.runner ?? new ProcessRunner();
    const timeoutMs = Math.max(1, Math.min(this.options.profile.turnTimeoutMinutes * 60_000, 2_147_483_647 - 1));
    const events: AgentEvent[] = [];
    const at = () => new Date().toISOString();
    const emit = (event: AgentEvent) => {
      events.push(event);
      this.input.onEvent?.(event);
    };

    // MCP 検知は stderr のみを対象にする。stdout の JSONL には議論本文が含まれ、
    // 議論トピック自体が MCP に言及しうるため誤検知する。stderr は codex CLI の
    // 動作ログであり、MCP サーバー起動はそこに現れる。
    const mcpMonitor = createMcpPolicyMonitor({
      policy: this.options.mcpPolicy ?? this.options.profile.inheritedMcpPolicy,
      mode: "non-interactive",
      explicitAllow: false,
    });

    let processHandle: ManagedProcess;
    try {
      processHandle = runner.run(executable, [...(this.options.executableArgs ?? []), ...EXEC_ARGS], {
        cwd: this.input.cwd,
        env: this.options.env ?? process.env,
        timeoutMs,
        abortSignal: this.input.abortSignal,
        terminationGraceMs: TERMINATION_GRACE_MS,
      });
    } catch (error) {
      if (error instanceof ProcessError) throw toCodexExecError(error);
      throw error;
    }
    this.active = processHandle;

    let text = "";
    let turnFailed: string | undefined;
    let stderrTail = "";
    let policyBlocked: string | undefined;
    let sawTurnCompleted = false;
    let sawAgentMessageCompleted = false;
    const partialByItem = new Map<string, number>();

    // structured な mcp_tool_call は stderr ヒューリスティックより確度の高い直接証拠。
    // warn は non-interactive では upstream で block 済みなので、allow 以外では止める。
    const blocksMcp = (this.options.mcpPolicy ?? this.options.profile.inheritedMcpPolicy) !== "allow";
    const blockForMcp = (transport: string) => {
      if (!blocksMcp || policyBlocked) return;
      policyBlocked = formatMcpSecurityAlert({ transport, action: "blocked-and-terminated" });
      void processHandle.terminateTree({ graceMs: TERMINATION_GRACE_MS }).catch(() => undefined);
    };

    const handleEvent = (event: ExecJsonEvent) => {
      if (
        (event.type === "item.started" || event.type === "item.completed")
        && typeof event.item?.type === "string"
        && event.item.type.startsWith("mcp")
      ) {
        blockForMcp("unknown");
        return;
      }
      if (event.type === "item.updated" && event.item?.type === "agent_message") {
        const itemId = event.item.id ?? "default";
        const fullText = event.item.text ?? "";
        const seenLength = partialByItem.get(itemId) ?? 0;
        if (fullText.length > seenLength) {
          partialByItem.set(itemId, fullText.length);
          emit({ type: "message.delta", sessionId: this.sessionId, text: fullText.slice(seenLength), at: at() });
        }
        return;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        const itemId = event.item.id ?? "default";
        const fullText = event.item.text ?? "";
        const seenLength = partialByItem.get(itemId) ?? 0;
        const remaining = fullText.slice(Math.min(seenLength, fullText.length));
        if (remaining.length > 0) {
          emit({ type: "message.delta", sessionId: this.sessionId, text: remaining, at: at() });
        }
        partialByItem.delete(itemId);
        text += fullText;
        sawAgentMessageCompleted = true;
        return;
      }
      if (event.type === "turn.completed") {
        sawTurnCompleted = true;
        emit({
          type: "turn.completed",
          sessionId: this.sessionId,
          ...(event.stop_reason ? { stopReason: event.stop_reason } : {}),
          at: at(),
        });
        return;
      }
      if (event.type === "turn.failed") {
        turnFailed = event.error?.message ?? "codex exec reported a failed turn";
        return;
      }
      if (event.type === "error" && typeof event.message === "string") {
        turnFailed = event.message;
      }
    };

    const stdoutDone = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of processHandle.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            const parsed = parseJsonLine(line);
            if (parsed) handleEvent(parsed);
          }
          newline = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      const trailing = buffer.trim();
      if (trailing.length > 0) {
        const parsed = parseJsonLine(trailing);
        if (parsed) handleEvent(parsed);
      }
    })().catch(() => undefined);

    const stderrDone = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of processHandle.stderr) {
        const decoded = decoder.decode(chunk, { stream: true });
        stderrTail = `${stderrTail}${decoded}`.slice(-MAX_STDERR_TAIL);
        if (!policyBlocked) {
          const decision = mcpMonitor.observe(decoded);
          if (decision.outcome === "block") {
            blockForMcp("unknown");
          }
        }
      }
    })().catch(() => undefined);

    // プロンプトは stdin 経由で渡す。子が既に終了している場合の EPIPE は
    // waitForExit 側の本来のエラーで報告するため、ここでは握りつぶす。
    try {
      await processHandle.writeStdin(this.composeInput(prompt.content));
      await processHandle.closeStdin();
    } catch {
      // EPIPE 等は下の waitForExit の結果に委ねる。
    }

    let exitError: ProcessError | undefined;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    try {
      const exit = await processHandle.waitForExit();
      exitCode = exit.code;
      exitSignal = exit.signal;
    } catch (error) {
      exitError = error instanceof ProcessError ? error : undefined;
      if (!exitError) throw error;
    } finally {
      if (this.active === processHandle) this.active = undefined;
    }
    await Promise.all([stdoutDone, stderrDone]);

    if (policyBlocked) {
      throw new CodexExecError("policy_blocked", policyBlocked);
    }
    if (exitError) {
      throw toCodexExecError(exitError);
    }
    if (turnFailed) {
      throw new CodexExecError("turn_failed", redactErrorMessage(turnFailed));
    }
    if (exitCode !== 0 || exitSignal) {
      const detail = exitSignal ? `signal ${exitSignal}` : `exit code ${exitCode ?? 1}`;
      const tail = stderrTail.trim();
      throw new CodexExecError(
        "process_crashed",
        redactErrorMessage(`codex exec exited with ${detail}${tail ? `: ${tail}` : ""}`),
      );
    }
    // exit 0 だけでは成功とみなさない。turn.completed と agent_message の
    // 整合性が取れない出力（空 JSONL、途中で欠けた item 等）は malformed として失敗させる。
    if (!sawTurnCompleted) {
      throw new CodexExecError(
        "malformed_message",
        "codex exec exited without a turn.completed event; output is not trustworthy",
      );
    }
    if (!sawAgentMessageCompleted) {
      throw new CodexExecError(
        "malformed_message",
        "codex exec completed the turn without any completed agent_message item",
      );
    }
    if (partialByItem.size > 0) {
      throw new CodexExecError(
        "malformed_message",
        "codex exec output ended with an agent_message item that never completed",
      );
    }
    return { sessionId: this.sessionId, text, events };
  }
}

export function createCodexExecRoleAgent(options: CreateCodexExecRoleAgentOptions): RoleAgent {
  const capture = options.captureSnapshot ?? captureGitWorktreeSnapshot;
  return {
    profileId: options.profile.id,
    kind: options.profile.kind,
    async openSession(input: OpenRoleSessionInput): Promise<RoleSession> {
      // ACP 経路と同じく snapshot 取得失敗は握りつぶさず失敗させる。
      // guard が効かない read-only セッションを黙って開かないため。
      const before = input.mode === "read-only"
        ? await capture({ cwd: input.cwd })
        : undefined;
      return new CodexExecRoleSession(options, input, before);
    },
  };
}

export interface DiagnoseCodexExecOptions {
  profile: AgentProfile;
  executable: string;
  executableArgs?: readonly string[];
  probeTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
}

/**
 * native exec 経路の事前診断。`codex --version` の起動確認だけを行う。
 * ACP プローブは使わない（exec 経路は ACP サーバーを介さない）。
 */
export async function diagnoseCodexExec(options: DiagnoseCodexExecOptions): Promise<AgentDiagnosis> {
  const errors: AgentDiagnosis["errors"] = [];
  const warnings: AgentDiagnosis["warnings"] = [];
  const runner = options.runner ?? new ProcessRunner();

  let probeError: ProcessError | undefined;
  let exitCode: number | null = null;
  try {
    const handle = runner.run(options.executable, [...(options.executableArgs ?? []), "--version"], {
      cwd: process.cwd(),
      env: options.env ?? process.env,
      timeoutMs: Math.max(1, options.probeTimeoutMs),
    });
    try {
      await handle.closeStdin();
    } catch {
      // stdin が閉じられない場合は waitForExit 側の結果に委ねる。
    }
    exitCode = (await handle.waitForExit()).code;
  } catch (error) {
    probeError = error instanceof ProcessError ? error : undefined;
    if (!probeError) throw error;
  }

  if (probeError || exitCode !== 0) {
    const missing = probeError?.code === "executable_not_found";
    errors.push({
      code: missing ? "executable_not_found" : "unknown",
      message: missing
        ? `Codex CLI executable not found: ${options.executable}`
        : `Codex CLI probe failed${probeError ? ` (${probeError.message})` : exitCode !== 0 ? ` (exit code ${exitCode ?? "unknown"})` : ""}`,
      nextAction: "Install the Codex CLI and ensure `codex` is on PATH (https://github.com/openai/codex)",
    });
  }

  return {
    executable: errors.length === 0
      ? { status: "ok", path: options.executable }
      : { status: "missing" },
    version: { status: errors.length === 0 ? "supported" : "unknown" },
    authentication: { status: "unknown" },
    acp: { status: "unknown" },
    inheritedMcpPolicy: options.profile.inheritedMcpPolicy,
    runnable: errors.length === 0,
    warnings,
    errors,
  };
}
