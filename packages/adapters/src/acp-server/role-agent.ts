import type {
  AgentDiagnosis,
  AgentEvent,
  AgentProfile,
  AgentPrompt,
  AgentTurnResult,
  OpenRoleSessionInput,
  RoleAgent,
  RoleSession,
} from "@meguribi/core";
import { agentDisplayName, resolveDiscussionMcpPolicy, type DiscussionMcpPolicy } from "@meguribi/core";
import { startAcpSession, type AcpSession } from "../acp/session.js";
import type { AcpTransport } from "../acp/transport.js";
import { createPermissionMediator } from "../acp/permissions.js";
import { AcpAgentArtifactStore } from "../acp/artifact-store.js";
import { createReadOnlyPermissionMediator } from "../acp/read-only-permissions.js";
import { captureGitWorktreeSnapshot, type GitWorktreeSnapshot } from "../git-boundary.js";
import { assertAcpServerRunnable } from "./diagnose.js";

export interface CreateAcpRoleAgentOptions {
  profile: AgentProfile;
  executable: string;
  executableArgs?: string[];
  acpArgs?: string[];
  diagnosis: AgentDiagnosis;
  mode: "interactive" | "non-interactive";
  /** 議論 Run 限定の明示 MCP 方針。未指定なら profile の従来 policy を使う。 */
  discussionMcpPolicy?: DiscussionMcpPolicy;
  transport?: AcpTransport;
  env?: NodeJS.ProcessEnv;
}

/**
 * read-only の役割セッションで worktree への書き込みを検出したときのエラー。
 * 権限要求を出さずに直接ファイルを書き換える経路も、セッション前後の
 * worktree スナップショット比較で検出する。
 */
export class RoleSessionWriteViolationError extends Error {
  readonly code = "policy_blocked" as const;
  readonly changedFiles: readonly string[];

  constructor(changedFiles: readonly string[]) {
    super(
      `Read-only role session modified the worktree: ${changedFiles.join(", ") || "(git head changed)"}`,
    );
    this.name = "RoleSessionWriteViolationError";
    this.changedFiles = changedFiles;
  }
}

function diffSnapshotPaths(
  before: GitWorktreeSnapshot,
  after: GitWorktreeSnapshot,
): string[] {
  const changed = new Set<string>();
  const collect = (
    beforeEntries: Readonly<Record<string, string>>,
    afterEntries: Readonly<Record<string, string>>,
  ) => {
    for (const key of new Set([...Object.keys(beforeEntries), ...Object.keys(afterEntries)])) {
      if (beforeEntries[key] !== afterEntries[key]) {
        changed.add(key);
      }
    }
  };
  collect(before.statusEntries, after.statusEntries);
  collect(before.fileDigests, after.fileDigests);
  return [...changed].sort();
}

function snapshotViolation(
  before: GitWorktreeSnapshot,
  after: GitWorktreeSnapshot,
): RoleSessionWriteViolationError | undefined {
  const changedFiles = diffSnapshotPaths(before, after);
  if (before.head !== after.head || changedFiles.length > 0) {
    return new RoleSessionWriteViolationError(changedFiles);
  }
  return undefined;
}

class AcpRoleSession implements RoleSession {
  readonly sessionId: string;
  private closed = false;

  constructor(
    private readonly session: AcpSession,
    private readonly input: OpenRoleSessionInput,
    private readonly before: GitWorktreeSnapshot | undefined,
    private readonly removeAbortListener: (() => void) | undefined,
  ) {
    this.sessionId = session.sessionId;
  }

  async send(prompt: AgentPrompt): Promise<AgentTurnResult> {
    const events: AgentEvent[] = [];
    let text = "";
    let stopReason: string | undefined;
    // ACP のターン失敗は session.failed イベントとしてではなく、
    // AcpTransportError 相当の例外として generator から投げられる。
    // ここでは握りつぶさず呼び出し側へそのまま伝える。
    for await (const event of this.session.prompt({ content: prompt.content })) {
      events.push(event);
      this.input.onEvent?.(event);
      if (event.type === "message.delta") {
        text += event.text;
      } else if (event.type === "turn.completed" && event.stopReason) {
        stopReason = event.stopReason;
      }
    }
    await this.assertUnmodified();
    return {
      sessionId: this.sessionId,
      text,
      ...(stopReason ? { stopReason } : {}),
      events,
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.removeAbortListener?.();
    try {
      await this.session.shutdown("completed", {
        gracefulShutdownMs: 1,
        terminateTimeoutMs: 1_000,
      });
    } catch {
      // shutdown は最初の呼び出しで memoize されるため、ここで失敗した場合の
      // terminate() は多くの場合同じ理由で失敗する。それでもプロセス回収を
      // 最後まで試み、成果物の write 済み分は残す。
      await this.session.terminate().catch(() => undefined);
    }
    await this.assertUnmodified();
  }

  private async assertUnmodified(): Promise<void> {
    if (!this.before) {
      return;
    }
    const after = await captureGitWorktreeSnapshot({ cwd: this.input.cwd });
    const violation = snapshotViolation(this.before, after);
    if (violation) {
      throw violation;
    }
  }
}

/**
 * ACP サーバーとして起動できるエージェント（claude-agent-acp / codex-acp 等の
 * 単体サーバー、または devin / cursor の acp サブコマンド）を役割セッションとして開く。
 * 診断が runnable でない場合はここで失敗させる。
 */
export function createAcpRoleAgent(options: CreateAcpRoleAgentOptions): RoleAgent {
  assertAcpServerRunnable(options.diagnosis);
  const { profile } = options;
  const effectiveInheritedMcpPolicy = options.discussionMcpPolicy === undefined
    ? profile.inheritedMcpPolicy
    : resolveDiscussionMcpPolicy({
        configured: [profile.inheritedMcpPolicy],
        discussionMcpPolicy: options.discussionMcpPolicy,
      });

  return {
    profileId: profile.id,
    kind: profile.kind,

    async openSession(input: OpenRoleSessionInput): Promise<RoleSession> {
      const policyContext = { mode: options.mode, allowedCommands: [] as readonly string[] };
      const permissionMediator = input.mode === "read-only"
        ? createReadOnlyPermissionMediator(policyContext)
        : createPermissionMediator(policyContext);

      const before = input.mode === "read-only"
        ? await captureGitWorktreeSnapshot({ cwd: input.cwd })
        : undefined;

      const session = await startAcpSession({
        executable: options.executable,
        executableArgs: options.executableArgs,
        acpArgs: options.acpArgs ?? [],
        cwd: input.cwd,
        env: options.env,
        startupTimeoutMs: profile.startupTimeoutMs,
        promptTimeoutMs: profile.turnTimeoutMinutes * 60_000,
        diagnosis: options.diagnosis,
        assertRunnable: assertAcpServerRunnable,
        artifactRoot: input.artifactRoot,
        createArtifactStore: (root) => new AcpAgentArtifactStore(root, {
          label: agentDisplayName(profile.kind),
          promptFileName: `${profile.id}-prompt.md`,
        }),
        permissionMediator,
        mcpPolicy: {
          policy: effectiveInheritedMcpPolicy,
          mode: options.mode,
          explicitAllow: false,
        },
        multiTurn: true,
        ...(options.transport ? { transport: options.transport } : {}),
      });

      let removeAbortListener: (() => void) | undefined;
      if (input.abortSignal) {
        const signal = input.abortSignal;
        const cancel = () => {
          void session.cancel().catch(() => undefined);
        };
        if (signal.aborted) {
          cancel();
        } else {
          signal.addEventListener("abort", cancel, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", cancel);
        }
      }

      return new AcpRoleSession(session, input, before, removeAbortListener);
    },
  };
}
