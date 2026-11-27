# P1 エージェント層 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code・Codex・Devin・Cursor を「役割」に割り当てて使えるエージェント層を作り、既存の `run` / `resume` で実装エージェントの動きが Claude Code のようなライブログとして流れるようにする。

**Architecture:** core に役割の型（`AgentProfile` / `RoleAgent` / `RoleSession`）とライブログ整形（`createLiveLogRenderer`）を置く。adapters では既存の汎用 ACP 層（`packages/adapters/src/acp`）の上に、単体で ACP サーバーとして動くエージェント（`claude-agent-acp`、`codex-acp`）用の診断・役割セッション・実装アダプター・計画/レビューブリッジを足す。既存の Devin / Cursor 経路と Codex SDK 経路は既定のまま残す。

**Tech Stack:** TypeScript strict、Valibot、`@agentclientprotocol/sdk`（既存）、Vitest、fake ACP server（`packages/adapters/src/devin/fixtures/fake-acp-server.js`）。

**Spec:** `docs/superpowers/specs/2026-11-27-multi-agent-orchestration-design.md`（§6.1、§6.6「進捗とエージェントの活動」「CLI のライブログ」）

## Global Constraints

- Node.js 24、pnpm、TypeScript strict。新しい npm 依存は追加しない（`claude-agent-acp` / `codex-acp` は利用者が別途インストールする外部実行ファイル）。
- 実エージェントを自動テストから呼ばない。ACP は fake server、計画/レビューは in-memory fake の `RoleAgent` で検証する。
- 既存テストを変更せずに通す（`pnpm test`）。既存の `implementer: devin|cursor`、`--implementer devin|cursor`、`MEGURIBI_IMPLEMENTER` の振る舞いを変えない。
- 既定の計画・レビュー担当は `codex`（`transport: sdk`、既存 `createCodexBridge`）のまま。
- 役割 ID・設定キーは設計書のもの: `agents`, `roles`, `discussants`, `summarizer`, `specifier`, `planner`, `implementer`, `reviewer`, `allowSameImplementerReviewer`。
- 組み込みプロファイル ID: `claude-code`（kind `claude-code`, transport `acp`, executable `claude-agent-acp`）、`codex`（kind `codex`, transport `sdk`）、`codex-acp`（kind `codex`, transport `acp`, executable `codex-acp`）、`devin`（kind `devin`, transport `acp`）、`cursor`（kind `cursor`, transport `acp`）。
- インストール案内: `claude-code` → `npm i -g @agentclientprotocol/claude-agent-acp`、`codex-acp` → `npm i -g @agentclientprotocol/codex-acp`。
- 構造化出力の再要求は最大2回。
- `transport: sdk` の `RoleSession`（設計書 §6.1 末尾）は P1 では作らない。議論（P3）で必要になった時点で足す。それまで Codex を議論に参加させるときは `codex-acp` プロファイルを使う。
- ライブログ: summary は 120 文字で切って末尾 `…`、表示前に redaction、色は TTY かつ `NO_COLOR` 未設定のときだけ。`--log stream`（既定）/ `compact` / `none`。`--json` のときは `none`。
- 各タスクの commit は Conventional Commits。末尾に `Co-Authored-By` を付ける。

## Review Focus

- 外部 ACP 実行ファイルが未インストール → `doctor --implementer claude-code` が `executable_not_found` と kind ごとのインストール案内を返し exit 1（Task 6 にテスト）。
- read-only 役割のエージェントが、権限要求を出さずにファイルを直接書き換える → セッション終了時の worktree 比較で検出し `RoleSessionWriteViolationError`（Task 7 にテスト）。
- 最終メッセージに JSON がない／JSON が複数ある／スキーマ外のキーがある → 最後の ```json ブロックだけを採用し、不正なら2回再要求してから `RolePlanningError`（Task 9 にテスト）。
- 同じ設定ファイルに旧 `implementer: devin` と `roles.implementer: claude-code` が両方ある → `conflicting_implementer` エラー。旧形式だけなら従来どおり（Task 4 にテスト）。
- ライブログで、発言の途中にツールイベントが割り込む／tool summary に token が入る／非 TTY → 改行を補い、redact し、ANSI を出さない（Task 2 にテスト）。

---

### Task 1: 役割の型と割り当て検証

**Files:**
- Create: `packages/core/src/role-agent.ts`
- Modify: `packages/core/src/index.ts`（export 追加）
- Test: `packages/core/src/role-agent.unit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AgentKind = "claude-code" | "codex" | "devin" | "cursor";
  export type AgentTransport = "acp" | "sdk";
  export type AgentRole = "discussant" | "summarizer" | "specifier" | "planner" | "implementer" | "reviewer";
  export interface AgentProfile {
    id: string; kind: AgentKind; transport: AgentTransport; executable?: string;
    startupTimeoutMs: number; turnTimeoutMinutes: number; inheritedMcpPolicy: InheritedMcpPolicy;
  }
  export interface RoleAssignments {
    discussants: readonly string[]; summarizer?: string; specifier?: string;
    planner: string; implementer?: string; reviewer: string; allowSameImplementerReviewer: boolean;
  }
  export type RoleSessionMode = "read-only" | "write";
  export interface AgentTurnResult { sessionId: string; text: string; stopReason?: string; events: readonly AgentEvent[] }
  export interface RoleSession { readonly sessionId: string; send(prompt: AgentPrompt): Promise<AgentTurnResult>; close(): Promise<void> }
  export interface OpenRoleSessionInput {
    cwd: string; mode: RoleSessionMode; role: AgentRole; artifactRoot: string;
    abortSignal?: AbortSignal; onEvent?: (event: AgentEvent) => void;
  }
  export interface RoleAgent { readonly profileId: string; readonly kind: AgentKind; openSession(input: OpenRoleSessionInput): Promise<RoleSession> }
  export type RoleAssignmentErrorCode = "unknown_profile" | "same_implementer_reviewer" | "transport_unsupported" | "duplicate_discussant";
  export class RoleAssignmentError extends Error { readonly code: RoleAssignmentErrorCode; readonly nextAction: string }
  export function validateRoleAssignments(assignments: RoleAssignments, profiles: readonly AgentProfile[]): void;
  export function agentDisplayName(kind: AgentKind): string; // "Claude Code" | "Codex" | "Devin" | "Cursor"
  ```

- [ ] **Step 1: 失敗するテストを書く**

```ts
const profiles: AgentProfile[] = [
  { id: "claude-code", kind: "claude-code", transport: "acp", executable: "claude-agent-acp", startupTimeoutMs: 10000, turnTimeoutMinutes: 45, inheritedMcpPolicy: "warn" },
  { id: "codex", kind: "codex", transport: "sdk", startupTimeoutMs: 10000, turnTimeoutMinutes: 45, inheritedMcpPolicy: "warn" },
  { id: "devin", kind: "devin", transport: "acp", startupTimeoutMs: 10000, turnTimeoutMinutes: 45, inheritedMcpPolicy: "warn" },
];
const base: RoleAssignments = { discussants: [], planner: "codex", reviewer: "codex", implementer: "devin", allowSameImplementerReviewer: false };

it("accepts the default assignment", () => expect(() => validateRoleAssignments(base, profiles)).not.toThrow());
it("rejects unknown profile ids", () =>
  expect(() => validateRoleAssignments({ ...base, reviewer: "gemini" }, profiles)).toThrow(expect.objectContaining({ code: "unknown_profile" })));
it("rejects the same implementer and reviewer", () =>
  expect(() => validateRoleAssignments({ ...base, reviewer: "devin" }, profiles)).toThrow(expect.objectContaining({ code: "same_implementer_reviewer" })));
it("allows the same implementer and reviewer when explicitly enabled", () =>
  expect(() => validateRoleAssignments({ ...base, reviewer: "devin", allowSameImplementerReviewer: true }, profiles)).not.toThrow());
it("rejects an sdk-transport implementer", () =>
  expect(() => validateRoleAssignments({ ...base, implementer: "codex", reviewer: "devin" }, profiles)).toThrow(expect.objectContaining({ code: "transport_unsupported" })));
it("rejects duplicate discussants", () =>
  expect(() => validateRoleAssignments({ ...base, discussants: ["devin", "devin"] }, profiles)).toThrow(expect.objectContaining({ code: "duplicate_discussant" })));
it("names agents for display", () => expect(agentDisplayName("claude-code")).toBe("Claude Code"));
```

- [ ] **Step 2: 失敗を確認** — Run: `pnpm exec vitest run packages/core/src/role-agent.unit.test.ts` / Expected: FAIL（module not found）
- [ ] **Step 3: `packages/core/src/role-agent.ts` を実装し `index.ts` から export する**
  `nextAction` は各 code で「`.meguribi.yml` の `roles.<role>` を既存のプロファイル ID に直す」「`allowSameImplementerReviewer: true` を明示する」「`agents.<id>.transport: acp` のプロファイルを選ぶ」「`discussants` の重複を除く」。
- [ ] **Step 4: 成功を確認** — 同じコマンドで PASS
- [ ] **Step 5: commit** — `git commit -m "feat(core): 役割ベースのエージェント型と割り当て検証を追加"`

### Task 2: ライブログ整形

**Files:**
- Create: `packages/core/src/live-log.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/live-log.unit.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`（`packages/core/src/agent-event.ts`）、`AgentRole`、`AgentKind`、`agentDisplayName`（Task 1）
- Produces:
  ```ts
  export type LiveLogEvent =
    | { type: "step.started"; stepId: string; label: string; role?: AgentRole; profileId?: string; agentLabel?: string }
    | { type: "agent.event"; stepId: string; profileId: string; agentLabel: string; role: AgentRole; event: AgentEvent };
  export type LiveLogMode = "stream" | "compact";
  export interface LiveLogOptions { mode: LiveLogMode; color: boolean; redact?: (text: string) => string; width?: number /* 既定 64 */; onlyProfileId?: string /* エージェント別画面用 */ }
  export interface LiveLogRenderer { render(event: LiveLogEvent): string; flush(): string }
  export function createLiveLogRenderer(options: LiveLogOptions): LiveLogRenderer;
  ```
  P2 の `WorkflowEvent` はこの2種を含む形で拡張する。

整形規則（色なしの出力。`render` は書き出す文字列そのものを返す）:

| 入力 | stream での出力 |
|---|---|
| `step.started` | `── <stepId> · <agentLabel> (<role>) ` を `─` で幅 64 まで埋め、末尾 `\n`。agentLabel がなければ `── <stepId> · <label> ` |
| `message.delta`（同じ session の発言の続きでない） | `● <agentLabel>  <text>` |
| `message.delta`（続き） | `<text>` |
| `tool.started` | `● <tool>  <summary>\n`（summary は redact → 120 文字で切って `…`。summary がなければ `● <tool>\n`） |
| `tool.completed` | `  └ <status ?? "completed">`＋（exitCode があれば ` · exit <n>`）＋（同じ toolCallId の開始時刻があれば ` · <秒、小数1桁>s`）＋`\n` |
| `file.changed` | `  └ changed · <path>\n` |
| `approval.required` | `⚠ 権限  <summary> → <許可/拒否/確認待ち>（<reason>）\n`（decision がなければ `→ 確認待ち\n`） |
| `session.failed` | `✗ <agentLabel>  <code>: <message>\n` |
| `session.started` / `turn.completed` / `unknown` | 空文字 |

- 発言の途中で発言以外のイベントが来たとき、直前の出力が `\n` で終わっていなければ先頭に `\n` を付ける。`flush()` も同様に未完の行を閉じる。
- `onlyProfileId` を指定したら、`profileId` が一致しない `agent.event` と `step.started`（`profileId` なしを含む）は空文字にする。P2 の `status --follow --agent` と P5 のエージェント別ペインがこれを使う。
- compact は `step.started`、`tool.started`（`  · <tool>  <summary>\n`）、`approval.required`、`session.failed` だけを出す。
- color が true のとき、agentLabel を profileId の初出順に cyan / magenta / yellow / green / blue（36/35/33/32/34）で循環させて色付けし、`✗` 行は赤（31）、`⚠` 行は黄（33）。false のときは ANSI を一切含めない。

- [ ] **Step 1: 失敗するテストを書く**

```ts
const ev = (event: AgentEvent): LiveLogEvent => ({ type: "agent.event", stepId: "implement", profileId: "devin", agentLabel: "Devin", role: "implementer", event });
const at = (s: number) => new Date(Date.UTC(2026, 10, 27, 0, 0, s)).toISOString();

it("streams messages and tools like an agent CLI", () => {
  const r = createLiveLogRenderer({ mode: "stream", color: false });
  const out = [
    r.render({ type: "step.started", stepId: "implement", label: "implement", role: "implementer", agentLabel: "Devin" }),
    r.render(ev({ type: "message.delta", sessionId: "s", text: "確認して", at: at(0) })),
    r.render(ev({ type: "message.delta", sessionId: "s", text: "から直します。", at: at(1) })),
    r.render(ev({ type: "tool.started", sessionId: "s", tool: "Terminal", toolCallId: "t1", summary: "pnpm test", at: at(2) })),
    r.render(ev({ type: "tool.completed", sessionId: "s", tool: "Terminal", toolCallId: "t1", exitCode: 0, at: at(14) })),
  ].join("");
  expect(out).toBe(
    "── implement · Devin (implementer) " + "─".repeat(64 - 35) + "\n" +
    "● Devin  確認してから直します。\n" +
    "● Terminal  pnpm test\n" +
    "  └ completed · exit 0 · 12.0s\n");
});
it("redacts and truncates tool summaries", () => {
  const r = createLiveLogRenderer({ mode: "stream", color: false, redact: (t) => t.replace(/token=\S+/g, "token=[REDACTED]") });
  expect(r.render(ev({ type: "tool.started", sessionId: "s", tool: "Terminal", summary: "curl token=abc", at: at(0) }))).toBe("● Terminal  curl token=[REDACTED]\n");
  expect(r.render(ev({ type: "tool.started", sessionId: "s", tool: "Read", summary: "x".repeat(130), at: at(0) }))).toBe(`● Read  ${"x".repeat(120)}…\n`);
});
it("renders permission decisions in Japanese", () => {
  const r = createLiveLogRenderer({ mode: "stream", color: false });
  expect(r.render(ev({ type: "approval.required", sessionId: "s", requestId: "p", summary: "git push", decision: { outcome: "deny", reason: "git_write is not permitted" }, at: at(0) })))
    .toBe("⚠ 権限  git push → 拒否（git_write is not permitted）\n");
});
it("emits no ANSI codes when color is off and closes open lines on flush", () => {
  const r = createLiveLogRenderer({ mode: "stream", color: false });
  const out = r.render(ev({ type: "message.delta", sessionId: "s", text: "途中", at: at(0) })) + r.flush();
  expect(out).toBe("● Devin  途中\n");
  expect(out).not.toMatch(/\u001b\[/);
});
it("colors agent labels when color is on", () => {
  const r = createLiveLogRenderer({ mode: "stream", color: true });
  expect(r.render(ev({ type: "message.delta", sessionId: "s", text: "a", at: at(0) }))).toContain("\u001b[36mDevin\u001b[0m");
});
it("renders only the selected agent for per-agent panes", () => {
  const r = createLiveLogRenderer({ mode: "stream", color: false, onlyProfileId: "codex" });
  expect(r.render({ type: "step.started", stepId: "implement", label: "implement", role: "implementer", profileId: "devin", agentLabel: "Devin" })).toBe("");
  expect(r.render(ev({ type: "tool.started", sessionId: "s", tool: "Edit", summary: "a.ts", at: at(0) }))).toBe("");
  expect(r.render({ type: "agent.event", stepId: "plan", profileId: "codex", agentLabel: "Codex", role: "planner",
    event: { type: "tool.started", sessionId: "c", tool: "Read", summary: "a.ts", at: at(0) } })).toBe("● Read  a.ts\n");
});
it("compact mode hides messages and completions", () => {
  const r = createLiveLogRenderer({ mode: "compact", color: false });
  expect(r.render(ev({ type: "message.delta", sessionId: "s", text: "a", at: at(0) }))).toBe("");
  expect(r.render(ev({ type: "tool.started", sessionId: "s", tool: "Edit", summary: "src/a.ts", at: at(0) }))).toBe("  · Edit  src/a.ts\n");
  expect(r.render(ev({ type: "tool.completed", sessionId: "s", tool: "Edit", at: at(1) }))).toBe("");
});
```

- [ ] **Step 2: 失敗を確認** — Run: `pnpm exec vitest run packages/core/src/live-log.unit.test.ts` / Expected: FAIL
- [ ] **Step 3: `createLiveLogRenderer` を実装する**（状態は closure 内に「直前の出力が改行で終わったか」「発言中の sessionId」「toolCallId → 開始時刻」「profileId → 色」を持つ）
- [ ] **Step 4: 成功を確認** — PASS
- [ ] **Step 5: commit** — `git commit -m "feat(core): エージェントCLI風のライブログ整形を追加"`

### Task 3: 既存 `run` / `resume` で実装エージェントのライブログを流す

**Files:**
- Modify: `packages/core/src/agent-adapter.ts`（`ImplementationInput` に `onEvent?: (event: AgentEvent) => void` を追加）
- Modify: `packages/core/src/delivery.ts`（`DeliveryDependencies` に `onAgentEvent?: (event: LiveLogEvent) => void` を追加）
- Modify: `packages/core/src/workflow/delivery.ts:607` 付近と `:837` 付近（`implement` / `fix` 呼び出しで `onEvent` を渡し、`profileId` 付きの `step.started` を発行）
- Modify: `packages/adapters/src/devin/acp-adapter.ts:317`、`packages/adapters/src/cursor/acp-adapter.ts:317`（`for await` ループで `input.onEvent?.(event)`）
- Modify: `apps/cli/src/commands/run.ts`（`withProgress` の隣に `withLiveLog` を足す）、`apps/cli/src/program.ts`（`run` / `resume` に `--log <mode>`）
- Test: `packages/adapters/src/cursor/acp-adapter.unit.test.ts` は変えない。新規 `packages/adapters/src/cursor/live-events.integration.test.ts`、`packages/adapters/src/workflow/delivery.live-log.fixture.test.ts`、`apps/cli/src/program.test.ts` に追記

**Interfaces:**
- Consumes: `LiveLogEvent`, `createLiveLogRenderer`（Task 2）
- Produces: `ImplementationInput.onEvent`、`DeliveryDependencies.onAgentEvent`。発行する `LiveLogEvent` は `stepId: "implement"`（`implement` 時）／`"fix"`（`fix` 時）、`role: "implementer"`、`profileId` と `agentLabel` は wiring から渡す（`DeliveryDependencies.implementerProfile?: { id: string; kind: AgentKind }` を追加。未設定時は `{ id: "devin", kind: "devin" }`）。

- [ ] **Step 1: 失敗するテストを書く**
  - `live-events.integration.test.ts`: fake ACP server（`FAKE_ACP_MODE=success`）で `createCursorAcpAdapter(...).implement({ ..., onEvent })` を実行し、受け取った type の列に `"message.delta"`, `"tool.started"`, `"tool.completed"` がこの順で含まれ、`message.delta` の text が `"fake ACP connected"` であることを assert する（起動オプションは既存の `cursor/transport.integration.test.ts` と同じ fake の渡し方）。
  - `delivery.live-log.fixture.test.ts`: 既存の `delivery.fixture.test.ts` と同じ fake 構成で、fake implementer が `onEvent` に `message.delta` を1回出すようにし、`onAgentEvent` が `{ type: "step.started", stepId: "implement" }` → `{ type: "agent.event", stepId: "implement", role: "implementer" }` の順で呼ばれることを assert する。
  - `program.test.ts`: `run --log compact` と `run --log none` が受け付けられ、`run --log loud` は `--log must be stream, compact, or none` で exit 1。
- [ ] **Step 2: 失敗を確認** — Run: `pnpm exec vitest run packages/adapters/src/cursor/live-events.integration.test.ts packages/adapters/src/workflow/delivery.live-log.fixture.test.ts apps/cli/src/program.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
  `withLiveLog(delivery, stderr, { mode, color })` は `createLiveLogRenderer` を作り、`onAgentEvent` の出力を stderr へ書く。`color = process.stderr.isTTY === true && process.env.NO_COLOR === undefined`。`redact` には `@meguribi/adapters` の `redactDiagnosticText` を渡す。`--log none` と `--json` のときは `withLiveLog` を掛けない。既存の `[meguribi] run=... status=...` 行は `--log stream|compact` でも残す。Run 終了時に `flush()` の結果を書く。
- [ ] **Step 4: 成功を確認** — 同じコマンドで PASS、続けて `pnpm test` で既存テストがすべて PASS
- [ ] **Step 5: commit** — `git commit -m "feat(run): 実装エージェントの動きをライブログで表示"`

### Task 4: `agents` / `roles` 設定

**Files:**
- Create: `packages/config/src/executable.ts`（`cursor-config.ts` の `executableSchema`、`isValidExecutableString`、`isValidExecutablePath` を移し、`cursor-config.ts` はここから import する）
- Create: `packages/config/src/agents-config.ts`
- Modify: `packages/config/src/config-loader.ts`（`loadAgentsConfig` を追加。`loadImplementerConfig` の結果に `{ kind: "acp-server"; profile: AgentProfile; snapshot }` を追加）
- Modify: `packages/config/src/index.ts`
- Test: `packages/config/src/agents-config.test.ts`

**Interfaces:**
- Consumes: `AgentProfile`, `RoleAssignments`, `validateRoleAssignments`（Task 1）
- Produces:
  ```ts
  export const BUILTIN_AGENT_PROFILES: readonly AgentProfile[]; // Global Constraints の5つ。timeouts は 10000 / 45、inheritedMcpPolicy は "warn"
  export interface AgentsConfigResult { profiles: readonly AgentProfile[]; roles: RoleAssignments; snapshot: Record<string, unknown> }
  export async function loadAgentsConfig(options: LoadDevinConfigOptions): Promise<AgentsConfigResult>;
  export class ConflictingImplementerError extends Error { readonly code: "conflicting_implementer"; readonly nextAction: string }
  // loadImplementerConfig の戻り値に追加:
  | { kind: "acp-server"; profile: AgentProfile; snapshot: Record<string, unknown> }
  ```

設定形式（`.meguribi.yml` とユーザー設定の両方）:

```yaml
agents:
  <id>:            # /^[a-z][a-z0-9-]{0,31}$/
    kind: claude-code | codex | devin | cursor
    transport: acp | sdk          # 省略時 acp
    executable: <string | [string]>
    startupTimeoutMs: <int>
    turnTimeoutMinutes: <int>
    inheritedMcpPolicy: warn | allow | deny
roles:
  discussants: [<id>, ...]
  summarizer: <id>
  specifier: <id>
  planner: <id>                   # 省略時 codex
  implementer: <id>
  reviewer: <id>                  # 省略時 codex
  allowSameImplementerReviewer: <bool>   # 省略時 false
```

- ユーザー定義プロファイルは同じ ID の組み込みを置き換え、新しい ID は追加される。`roles` はユーザー設定 → リポジトリ設定の順にキー単位で上書きする。
- `roles.implementer` の決定順は既存と同じ: CLI `--implementer` → `MEGURIBI_IMPLEMENTER` → ユーザー設定（`roles.implementer`、なければ旧 `implementer`）→ リポジトリ設定（同）。同じファイル内で旧 `implementer` と `roles.implementer` が異なれば `ConflictingImplementerError`。
- `loadImplementerConfig` は、決まった implementer が `devin` / `cursor` の kind なら従来どおり `loadDevinConfig` / `loadCursorConfig` を返す。それ以外の acp プロファイルなら `{ kind: "acp-server", profile }`。`sdk` プロファイルなら `RoleAssignmentError("transport_unsupported")`。未指定なら従来どおり `ImplementerNotSpecifiedError`（メッセージの候補に `claude-code|codex-acp` を加える）。
- `loadAgentsConfig` は最後に `validateRoleAssignments` を呼ぶ。

- [ ] **Step 1: 失敗するテストを書く**（一時ディレクトリに `.meguribi.yml` を書いて `loadAgentsConfig({ repositoryPath, userConfigPath, environment: {} })` を呼ぶ）
  - 設定なし → `roles` が `{ discussants: [], planner: "codex", reviewer: "codex", allowSameImplementerReviewer: false }`、`profiles` の ID 列が `["claude-code", "codex", "codex-acp", "devin", "cursor"]`。
  - 旧 `implementer: devin` だけ → `roles.implementer === "devin"`。
  - `implementer: devin` と `roles: { implementer: claude-code }` が同じファイル → `code: "conflicting_implementer"`。
  - `agents: { claude-code: { kind: claude-code, executable: my-claude-acp } }` → `claude-code` の executable が `my-claude-acp`、transport `acp`。
  - `agents: { Bad_ID: { kind: devin } }` → `Invalid agents configuration: agents.Bad_ID` を含むエラー。
  - `loadImplementerConfig({ cli: { implementer: "claude-code" } })` → `kind: "acp-server"`、`profile.id === "claude-code"`。
  - `loadImplementerConfig({ cli: { implementer: "codex" } })` → `code: "transport_unsupported"`。
- [ ] **Step 2: 失敗を確認** — Run: `pnpm exec vitest run packages/config/src/agents-config.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**（Valibot の `strictObject`。executable の検証は `executable.ts` を使う）
- [ ] **Step 4: 成功を確認** — 上記と `pnpm exec vitest run packages/config` が PASS（既存の `config-loader.test.ts` / `devin-config.test.ts` を含む）
- [ ] **Step 5: commit** — `git commit -m "feat(config): agentsとrolesの設定を追加"`

### Task 5: 汎用 ACP の成果物ストアと実装プロンプトを共通化

**Files:**
- Create: `packages/adapters/src/acp/artifact-store.ts`（`cursor/artifact-store.ts` の実装を移す）
- Modify: `packages/adapters/src/cursor/artifact-store.ts`（移した実装を継承する薄いラッパーにする）
- Create: `packages/adapters/src/acp/implementation-prompt.ts`（`cursor/prompt.ts` の実装を移す）
- Modify: `packages/adapters/src/cursor/prompt.ts`（ラッパーにする）
- Test: 既存の Cursor のテストを変更せずに通すことで確認する。新規 `packages/adapters/src/acp/artifact-store.unit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class AcpArtifactWriteError extends Error {}
  export class AcpAgentArtifactStore implements AcpArtifactStore {
    constructor(root: string, options?: { label?: string /* 既定 "ACP" */; promptFileName?: string /* 既定 "agent-prompt.md" */ });
  }
  export class AcpPromptBuildError extends Error {}
  export function buildAcpImplementationPrompt(context: ImplementationContext, options: { version: string; label: string }): { version: string; hash: string; content: string };
  ```
  `CursorAgentArtifactStore` は `label: "Cursor"`、`promptFileName: "cursor-prompt.md"` で継承する。`CursorArtifactWriteError` は `AcpArtifactWriteError` を継承する。`buildCursorPrompt(context)` は `buildAcpImplementationPrompt(context, { version: CURSOR_PROMPT_VERSION, label: "Cursor" })` を返し、`CursorPromptBuildError` は `AcpPromptBuildError` を継承する。エラーメッセージ中の `Cursor` は `label` に置き換える（Cursor では同じ文字列になる）。

- [ ] **Step 1: 失敗するテストを書く** — `new AcpAgentArtifactStore(root, { label: "Claude Code", promptFileName: "claude-code-prompt.md" })` の `promptPath` が `path.join(root, "claude-code-prompt.md")`、`init()` 後に `root` が存在する。
- [ ] **Step 2: 失敗を確認** — Run: `pnpm exec vitest run packages/adapters/src/acp/artifact-store.unit.test.ts` / Expected: FAIL
- [ ] **Step 3: 移動とラッパー化を行う**（振る舞いは変えない）
- [ ] **Step 4: 成功を確認** — Run: `pnpm exec vitest run packages/adapters/src/acp packages/adapters/src/cursor` / Expected: すべて PASS（既存 Cursor テストを含む）
- [ ] **Step 5: commit** — `git commit -m "refactor(adapters): ACP成果物ストアと実装プロンプトを共通化"`

### Task 6: 単体 ACP サーバーの診断

**Files:**
- Create: `packages/adapters/src/acp-server/diagnose.ts`
- Create: `packages/adapters/src/acp-server/format.ts`（`formatAcpServerDiagnosisHuman`。`cursor/format.ts` と同じ体裁、見出しは `agentDisplayName(kind)`）
- Create: `packages/adapters/src/acp-server/index.ts`、Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/src/acp-server/diagnose.integration.test.ts`

**Interfaces:**
- Consumes: `AcpTransport` / `createAcpTransport`（`acp/transport.ts`）、`AgentProfile`、`agentDisplayName`
- Produces:
  ```ts
  export interface DiagnoseAcpServerOptions {
    profile: AgentProfile; executable: string; executableArgs?: string[];
    cwd: string; nonInteractive: boolean; probeTimeoutMs: number; transport?: AcpTransport; env?: NodeJS.ProcessEnv;
  }
  export async function diagnoseAcpServer(options: DiagnoseAcpServerOptions): Promise<AgentDiagnosis>;
  export class AcpServerNotRunnableError extends Error {}
  export function assertAcpServerRunnable(diagnosis: AgentDiagnosis): void;
  export function acpServerInstallHint(profile: AgentProfile): string;
  ```
  判定: `transport.start({ executable, executableArgs, acpArgs: [], cwd, startupTimeoutMs: probeTimeoutMs, diagnosis: <executable ok の仮診断>, assertRunnable: () => {} })` で initialize と session 作成まで行い、すぐ `terminate()`。成功 → `executable.status "ok"`、`acp.status "supported"`、`acp.supportsSessionLoad` は接続の値、`version.status "unknown"`（警告 `unknown_version`）、`authentication.status "unknown"`（警告 `auth_unknown`）。`AcpTransportError` の `spawn_failure` → `executable_not_found`（`nextAction` は `acpServerInstallHint`）、`startup_timeout` → `timeout`、`initialize_failure` / `capability_mismatch` / `session_creation_failure` → `acp.status "unsupported"` と `protocol_initialization_failure`。MCP ポリシーは `cursor/diagnose.ts` の `evaluateMcpPolicy` と同じ規則（`warn` かつ非対話は `policy_blocked`）。`runnable` は errors が空のとき true。

- [ ] **Step 1: 失敗するテストを書く**（`executable: process.execPath`、`executableArgs: [fakeAcpServer()]`）
  - `FAKE_ACP_MODE=success` → `runnable: true`、`acp.status: "supported"`、warnings の code に `auth_unknown` と `unknown_version`。
  - `executable: "meguribi-no-such-acp"` → `runnable: false`、`errors[0].code: "executable_not_found"`、`errors[0].nextAction: "npm i -g @agentclientprotocol/claude-agent-acp"`（profile が `claude-code` のとき）。
  - `FAKE_ACP_MODE=startup-hang`、`probeTimeoutMs: 300` → `errors[0].code: "timeout"`。
  - `FAKE_ACP_MODE=crash-before-init` → `runnable: false`。
  - `inheritedMcpPolicy: "warn"` かつ `nonInteractive: true` → `errors` に `policy_blocked`。
- [ ] **Step 2: 失敗を確認** — Run: `pnpm exec vitest run packages/adapters/src/acp-server/diagnose.integration.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 成功を確認** — PASS
- [ ] **Step 5: commit** — `git commit -m "feat(adapters): 単体ACPサーバー(Claude Code/Codex)の診断を追加"`

### Task 7: 役割セッション（read-only / write）

**Files:**
- Create: `packages/adapters/src/acp-server/role-agent.ts`
- Create: `packages/adapters/src/acp/read-only-permissions.ts`
- Test: `packages/adapters/src/acp-server/role-agent.integration.test.ts`、`packages/adapters/src/acp/read-only-permissions.unit.test.ts`

**Interfaces:**
- Consumes: `startAcpSession`（`acp/session.ts`）、`createPermissionMediator`（`acp/permissions.ts`）、`AcpAgentArtifactStore`（Task 5）、`assertAcpServerRunnable`（Task 6）、`captureGitWorktreeSnapshot`（`git-boundary.ts`）、Task 1 の型
- Produces:
  ```ts
  export interface CreateAcpRoleAgentOptions {
    profile: AgentProfile; executable: string; executableArgs?: string[]; diagnosis: AgentDiagnosis;
    mode: "interactive" | "non-interactive"; transport?: AcpTransport; env?: NodeJS.ProcessEnv;
  }
  export function createAcpRoleAgent(options: CreateAcpRoleAgentOptions): RoleAgent;
  export class RoleSessionWriteViolationError extends Error { readonly code: "policy_blocked"; readonly changedFiles: readonly string[] }
  export function createReadOnlyPermissionMediator(context: PermissionPolicyContext): PermissionMediator;
  ```
  - `createReadOnlyPermissionMediator`: `file_read` は通常の判定（`createPermissionMediator`）に委ね、それ以外の operation はすべて `{ outcome: "deny", reason: "role session is read-only" }`。
  - `openSession` は `startAcpSession` を `acpArgs: []`、`startupTimeoutMs: profile.startupTimeoutMs`、`promptTimeoutMs: profile.turnTimeoutMinutes * 60_000`、`createArtifactStore: (root) => new AcpAgentArtifactStore(root, { label: agentDisplayName(profile.kind), promptFileName: `${profile.id}-prompt.md` })` で起動する。read-only は上記 mediator、write は通常の mediator。
  - read-only のとき、開始時に `captureGitWorktreeSnapshot({ cwd })` を取り、`send` の各ターン後と `close()` で再取得して `head`・`statusEntries`・`fileDigests` を比較する。差があれば `RoleSessionWriteViolationError`（`changedFiles` は差分のあったパス）。
  - `send` はイベントを `onEvent` へ逐次渡し、`message.delta` の text を連結した `text`、`turn.completed` の `stopReason`、全イベントを返す。`session.failed` は `AcpTransportError` 相当のエラーとして throw する。

- [ ] **Step 1: 失敗するテストを書く**
  - unit: read-only mediator が `file_write` / `command` / `git_write` を deny、worktree 内の `file_read` を approve。
  - integration（一時 Git リポジトリ + fake server）: `FAKE_ACP_MODE=success`、read-only で `send({ content: "hi" })` → `text === "fake ACP connected"`、`onEvent` に `message.delta` が届く。
  - `FAKE_ACP_MODE=write-in-scope`、read-only → `RoleSessionWriteViolationError` で、`changedFiles` が空でない（fake が権限要求なしに直接書く経路の検出）。
  - `FAKE_ACP_MODE=permission`、read-only → 権限要求に deny が返り、ログ（`approval.required` の decision.outcome）が `"deny"`。
  - `FAKE_ACP_MODE=write-in-scope`、write → エラーにならない。
- [ ] **Step 2: 失敗を確認** — Run: `pnpm exec vitest run packages/adapters/src/acp-server/role-agent.integration.test.ts packages/adapters/src/acp/read-only-permissions.unit.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 成功を確認** — PASS
- [ ] **Step 5: commit** — `git commit -m "feat(adapters): read-only/writeの役割セッションを追加"`

### Task 8: 単体 ACP サーバーを実装担当にする

**Files:**
- Create: `packages/adapters/src/acp/implementer-adapter.ts`（`cursor/acp-adapter.ts` の本体を、エージェント固有部分をフックとして受け取る形で移す）
- Modify: `packages/adapters/src/cursor/acp-adapter.ts`（フックを渡す薄いラッパーにする）
- Create: `packages/adapters/src/acp-server/implementer.ts`
- Test: 既存の Cursor のテストを変更せずに通すこと。新規 `packages/adapters/src/acp-server/implementer.integration.test.ts`

**Interfaces:**
- Consumes: Task 5、Task 6、`startAcpSession`
- Produces:
  ```ts
  export interface AcpImplementerHooks {
    label: string;
    assertRunnable(diagnosis: AgentDiagnosis): void;
    isNotRunnableError(error: unknown): boolean;
    isPromptBuildError(error: unknown): boolean;
    isArtifactWriteError(error: unknown): boolean;
    startSession(input: StartAcpSessionInput & { implementationContext: ImplementationContext }): Promise<AcpSession>;
  }
  export function createGenericAcpImplementer(options: CursorAcpAdapterOptions & { hooks: AcpImplementerHooks; acpArgs?: string[] }): AgentAdapter;
  export function createAcpServerImplementer(options: Omit<CursorAcpAdapterOptions, "executable"> & { profile: AgentProfile; executable: string; executableArgs?: string[] }): AgentAdapter;
  ```
  `createAcpServerImplementer` は `acpArgs: []`、プロンプトは `buildAcpImplementationPrompt(context, { version: "meguribi-acp-prompt/v1", label: agentDisplayName(profile.kind) })`、成果物ストアは `AcpAgentArtifactStore`。Git 境界・権限・MCP・shutdown の扱いは Cursor と同一（共通本体を使うため）。

- [ ] **Step 1: 失敗するテストを書く** — 一時 Git リポジトリ + fake server（`FAKE_ACP_MODE=write-in-scope`）で `createAcpServerImplementer({ profile: claudeCodeProfile, executable: process.execPath, executableArgs: [fakeAcpServer()], ... }).implement(...)` → `status: "completed"`、`changedFiles` に fake が書いたファイル、`artifactPaths.root` 配下に `claude-code-prompt.md`。`FAKE_ACP_MODE=write-outside` → `publishable: false`。
- [ ] **Step 2: 失敗を確認** — Run: `pnpm exec vitest run packages/adapters/src/acp-server/implementer.integration.test.ts` / Expected: FAIL
- [ ] **Step 3: 共通本体を抽出し、Cursor をラッパー化し、`createAcpServerImplementer` を実装する**
- [ ] **Step 4: 成功を確認** — Run: `pnpm exec vitest run packages/adapters/src/acp-server packages/adapters/src/cursor` / Expected: すべて PASS
- [ ] **Step 5: commit** — `git commit -m "feat(adapters): Claude Code/Codex ACPを実装担当として使えるようにする"`

### Task 9: 任意エージェントによる計画・レビュー

**Files:**
- Modify: `packages/schemas/src/codex-artifact.ts:25`（`producer.kind` を `v.picklist(["codex", "claude-code", "devin", "cursor"])` に広げる）、`packages/core/src/codex-artifact.ts:15`（同じ型）
- Create: `packages/adapters/src/role-planning/extract-json.ts`、`packages/adapters/src/role-planning/bridge.ts`、`packages/adapters/src/role-planning/index.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/src/role-planning/extract-json.unit.test.ts`、`packages/adapters/src/role-planning/bridge.unit.test.ts`、`packages/schemas/src/codex-artifact.test.ts` に追記

**Interfaces:**
- Consumes: `RoleAgent`（Task 1）、`buildPlanningPrompt` / `buildReviewPrompt` / `buildRepairPrompt`（`codex/prompt.ts`）、`PlanContentSchema` / `ReviewContentSchema`（schemas）、`digestSource`（codex）
- Produces:
  ```ts
  export function extractFinalJson(text: string): unknown | undefined; // 最後の ```json フェンス。なければ undefined
  export class RolePlanningError extends Error { readonly code: "malformed_output" | "policy_blocked"; readonly attempts: number }
  export function createRoleAgentPlanningBridge(options: {
    planner: RoleAgent; reviewer: RoleAgent; artifactRoot: string; onEvent?: (event: LiveLogEvent) => void; now?: () => Date;
  }): DeliveryDependencies["codex"];
  ```
  - `createPlan`: `planner.openSession({ cwd: repositoryPath, mode: "read-only", role: "planner", artifactRoot: <artifactRoot>/planner-<timestamp> })`。プロンプトは `buildPlanningPrompt` に「最後に ```json フェンスで、次のキーだけを持つ JSON を1つ出力する」と `PlanContentSchema` のキー一覧を付けたもの。`extractFinalJson` → `v.safeParse(PlanContentSchema)`。失敗したら同じセッションで `buildRepairPrompt("planner", <issue の要約>)` を送り、最大2回。3回目も失敗なら `RolePlanningError("malformed_output", attempts: 3)`。`RoleSessionWriteViolationError` は `RolePlanningError("policy_blocked")` に変換する。
  - 成功時は `PlanArtifact` を組み立てる: `metadata.producer = { kind: planner.kind, role: "planner", threadId: session.sessionId }`、`sourceDigests` は既存 `createCodexBridge` と同じキー、`eventLog` は `[]`。
  - `review` も同じ手順で `ReviewContentSchema`、`role: "reviewer"`。
  - `onEvent` には `stepId: "plan" | "review"`、`role`、`agentLabel: agentDisplayName(kind)` を付けて渡す。

- [ ] **Step 1: 失敗するテストを書く**
  - `extractFinalJson`: 2つの ```json ブロックがあれば最後を返す／フェンスなし → `undefined`／壊れた JSON → `undefined`。
  - bridge（台本どおりに応答する in-memory の `RoleAgent` fake を使う）: 1回目は JSON なし、2回目で正しい `PlanContent` → 成功し、送信回数が2、`metadata.producer.kind === "claude-code"`。
  - 3回とも余分なキー入りの JSON → `RolePlanningError`、`code: "malformed_output"`、`attempts: 3`。
  - fake の `send` が `RoleSessionWriteViolationError` を投げる → `code: "policy_blocked"`。
  - schemas: `producer.kind: "claude-code"` の `PlanArtifact` が `PlanArtifactSchema` を通り、`producer.kind: "gemini"` は通らない。
- [ ] **Step 2: 失敗を確認** — Run: `pnpm exec vitest run packages/adapters/src/role-planning packages/schemas/src/codex-artifact.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 成功を確認** — PASS、続けて `pnpm test` が PASS
- [ ] **Step 5: commit** — `git commit -m "feat(adapters): 任意のエージェントで計画とレビューを行えるようにする"`

### Task 10: 配線・CLI・ドキュメント

**Files:**
- Modify: `apps/cli/src/wiring/create-delivery-deps.ts`（`createDeliveryDeps`、`createPlanDependencies`、`createReviewDependencies`）
- Modify: `apps/cli/src/program.ts`（`doctor` / `run` / `resume` の `--implementer` 説明、`runDoctor` の分岐）
- Modify: `docs/ja/cli-and-integrations.md`、`docs/en/cli-and-integrations.md`
- Test: `apps/cli/src/program.test.ts` に追記、新規 `apps/cli/src/wiring/create-delivery-deps.unit.test.ts`

**Interfaces:**
- Consumes: Task 3（`onAgentEvent`、`implementerProfile`）、Task 4（`loadAgentsConfig`、`loadImplementerConfig` の `acp-server`）、Task 6（`diagnoseAcpServer`、`formatAcpServerDiagnosisHuman`）、Task 7（`createAcpRoleAgent`）、Task 8（`createAcpServerImplementer`）、Task 9（`createRoleAgentPlanningBridge`）
- Produces: `DoctorDependencies.diagnoseAcpServer?: typeof diagnoseAcpServer`、`DoctorDependencies.loadAgentsConfig?`（テスト注入用）

- [ ] **Step 1: 失敗するテストを書く**
  - `program.test.ts`: `doctor --implementer claude-code --json` で、注入した `diagnoseAcpServer` fake が `{ runnable: false, errors: [{ code: "executable_not_found", nextAction: "npm i -g @agentclientprotocol/claude-agent-acp", ... }] }` を返す → stdout の JSON に同じ内容、exit code 1。
  - 同じく `runnable: true` → exit code 0、人間向け出力の1行目に `Claude Code`。
  - `doctor --implementer devin` は従来どおり `diagnoseDevin` が呼ばれる（既存テストが通ること）。
  - `create-delivery-deps.unit.test.ts`: `roles: { planner: claude-code, reviewer: codex }` のとき `createPlanDependencies` の `codex.createPlan` が role-planning ブリッジ経由になり（`createAcpRoleAgent` を注入 fake にして呼ばれたことを確認）、`planner: codex` のときは既存 `createCodexBridge` が使われる。`roles.reviewer` と `roles.implementer` が同じなら `RoleAssignmentError("same_implementer_reviewer")` が `nextAction` 付きで CLI まで届く。
- [ ] **Step 2: 失敗を確認** — Run: `pnpm exec vitest run apps/cli/src` / Expected: FAIL
- [ ] **Step 3: 配線する**
  - implementer が `acp-server` なら `diagnoseAcpServer` → `createAcpServerImplementer`。`assertImplementerReady` / `assertDevinReady` は `diagnoseAcpServer` を再実行して `assertAcpServerRunnable`。
  - planner / reviewer のプロファイルが `codex`（sdk）なら `createCodexBridge()`。それ以外は、それぞれ `diagnoseAcpServer` → `createAcpRoleAgent` → `createRoleAgentPlanningBridge`。planner と reviewer の一方だけが sdk の場合、`createPlan` と `review` を別々のブリッジから取って1つの `DeliveryDependencies["codex"]` に組み合わせる。
  - `implementerProfile` に解決済みプロファイルの `{ id, kind }` を入れる。
  - `--implementer` の説明: `"Implementer agent profile (devin, cursor, claude-code, codex-acp, or a profile id from .meguribi.yml)"`。
- [ ] **Step 4: ドキュメントを日英で更新する** — `cli-and-integrations.md` に `agents` / `roles` の設定形式（Task 4 の YAML）、組み込みプロファイル5つ、インストール案内、`--log stream|compact|none` とライブログの例（設計書 §6.6 の例）を追記する。
- [ ] **Step 5: 全体検証** — Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` / Expected: すべて exit code 0
- [ ] **Step 6: commit** — `git commit -m "feat(cli): 役割割り当てとClaude Code/Codex ACPを配線"`
