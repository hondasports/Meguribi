# P2b イベントログ・活動状態・status コマンド・定義の読み込み Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run の全イベントを `events.jsonl` に残し、別の端末から `meguribi status <runId> --follow --agent <id>` でエージェントごとのライブログと活動状態を追えるようにする。あわせて YAML のワークフロー定義を読み込み・検査できるようにする。

**Architecture:** 前半（Task 1〜4）は P2a の移植作業と独立に作れる部品: 活動状態の導出（core の純粋関数）、イベントログの保存・読み出し（core の port と adapters の実装）、`status` コマンド、YAML 定義の parser と `workflow validate`。後半（Task 5〜7）は P2a 第2段（`runDelivery` の移植、`DeliveryDependencies.onWorkflowEvent`、`createDeliveryWorkflow`）が main に入ってから着手し、`run` / `resume` が実際にイベントを書き出すよう配線する。

**Tech Stack:** TypeScript strict、Valibot、`yaml`（`packages/config` の既存依存）、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-27-multi-agent-orchestration-design.md`（§6.5、§6.6、§6.7）

## Global Constraints

- Node.js 24、pnpm、TypeScript strict。新しい npm 依存は追加しない。
- 既存テストを変更せずに通す。既存コマンドの出力・終了コードを変えない（`status` と `workflow` は新規コマンド）。
- イベントは保存前に secret redaction を通す（`packages/adapters/src/acp/redact.ts` の `redactJsonValue`）。
- `events.jsonl` は Run ディレクトリ直下（`<root>/runs/<owner>/<repo>/issue-<n>/<runId>/events.jsonl`）。1行1イベント、形式は `{"at": "<ISO8601>", "event": <WorkflowEvent>}`。
- `stallWarningMs` の既定は 120000（2分）。応答なしは表示だけで、工程は止めない。
- `status --follow` は 1 秒ごとに追記分を読む。Run の `status` が `awaiting_human` / `blocked` / `failed` / `cancelled` / `timed_out` / `interrupted` になり、最後まで読み終えたら exit 0 で終わる。SIGINT でも exit 0。
- 実エージェント・実 GitHub を自動テストから呼ばない。
- 各タスクの commit は Conventional Commits。末尾に `Co-Authored-By` を付ける。

## Review Focus

- `events.jsonl` の最終行が書きかけ（改行なし）の状態で読む → その行は読まずに次回へ回す（Task 2 にテスト）。
- 壊れた JSON の行が混じる → その行だけ飛ばして警告を1回 stderr に出し、残りは読む（Task 2・3 にテスト）。
- 発言（`message.delta`）に token が含まれる → 保存時点で redaction 済み（Task 2 にテスト）。
- `--agent` に存在しないプロファイル ID → 「この Run に <id> のイベントはありません」と表示し、`--follow` なら待ち続ける（Task 3 にテスト）。
- 存在しない runId → `Run not found: <runId>` と nextAction（`meguribi status` に渡す runId は `run` の出力にある）を出して exit 1（Task 3 にテスト）。

---

## 前半（P2a 第2段と並行して着手してよい）

### Task 1: 活動状態の導出

**Files:**
- Create: `packages/core/src/agent-activity.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/agent-activity.unit.test.ts`

**Interfaces:**
- Consumes: `WorkflowEvent`（`packages/core/src/workflow-engine/events.ts`）、`AgentRole`
- Produces:
  ```ts
  export type AgentActivityState = "starting" | "thinking" | "running_tool" | "waiting_permission" | "idle" | "finished" | "failed";
  export interface AgentActivity {
    profileId: string; agentLabel: string; role: AgentRole; stepId: string;
    state: AgentActivityState; detail?: string; since: string; lastEventAt: string;
    toolCalls: number; changedFiles: readonly string[]; stalled: boolean; stalledForMs: number;
  }
  export interface DeriveAgentActivityOptions { now: Date; stallWarningMs?: number /* 既定 120000 */ }
  export function deriveAgentActivity(events: readonly WorkflowEvent[], options: DeriveAgentActivityOptions): AgentActivity[];
  ```
  規則（設計書 §6.6）: `agent.event` だけを見る。プロファイルごとに最後の状態を返し、並び順はそのプロファイルの初出順。
  - `session.started` → `starting`、`message.delta` → `thinking`（`detail` は直近の発言の冒頭 80 文字。続けて届いた delta は連結してから切る）、`tool.started` → `running_tool`（`detail` は `summary ?? tool`、`toolCalls` +1）、`tool.completed` → `thinking`、`approval.required` → `waiting_permission`（`detail` は summary）、`file.changed` → `changedFiles` に追加（重複なし、状態は変えない）、`turn.completed` → `idle`、`session.failed` → `failed`。
  - `since` はその state に入ったイベントの `at`、`lastEventAt` は最後のイベントの `at`。
  - `stalled` は state が `finished` / `failed` / `idle` 以外で `now - lastEventAt >= stallWarningMs` のとき true。`stalledForMs` はその差（stalled でなければ 0）。
  - 工程が変わって同じプロファイルの `step.started` が来たら、`stepId` を更新し、`toolCalls` と `changedFiles` をリセットする。
  - `workflow.finished` が来たら、全プロファイルの state を、`failed` 以外は `finished` にする。

- [ ] **Step 1: 失敗するテストを書く** — 上の規則を1つずつ確かめる。例: `tool.started`（summary "pnpm test"）の後 → state `running_tool`、detail `"pnpm test"`、toolCalls 1。`now` を lastEventAt + 120000ms にすると stalled true・stalledForMs 120000、+119999ms なら false。発言 100 文字 → detail は 80 文字。2プロファイルのイベントが混ざっても初出順で2件返る。
- [ ] **Step 2: 失敗を確認** — `pnpm exec vitest run packages/core/src/agent-activity.unit.test.ts` / FAIL
- [ ] **Step 3: 実装**（純粋関数）
- [ ] **Step 4: 成功を確認** — PASS
- [ ] **Step 5: commit** — `feat(core): エージェントの活動状態を導出する`

### Task 2: イベントログの保存と読み出し

**Files:**
- Create: `packages/core/src/workflow-engine/event-log.ts`（port）
- Create: `packages/adapters/src/run-store/workflow-event-log.ts`
- Modify: `packages/adapters/src/run-store/filesystem-run-store.ts`（`runDirectory(runId)` を public に追加。中身は既存の `resolveRunDirById`）
- Modify: `packages/core/src/index.ts`、`packages/adapters/src/run-store/index.ts`、`packages/adapters/src/index.ts`
- Test: `packages/adapters/src/run-store/workflow-event-log.unit.test.ts`

**Interfaces:**
- Consumes: `WorkflowEvent`、`FileSystemRunStore`、`redactJsonValue`
- Produces:
  ```ts
  // core
  export interface WorkflowEventRecord { at: string; event: WorkflowEvent }
  export interface WorkflowEventLog {
    append(runId: string, event: WorkflowEvent, at?: string): Promise<void>;
    read(runId: string, fromLine?: number): Promise<{ records: WorkflowEventRecord[]; nextLine: number; skippedLines: number }>;
  }
  // adapters
  export class FileSystemWorkflowEventLog implements WorkflowEventLog {
    constructor(options: { runStore: FileSystemRunStore; now?: () => Date });
  }
  // FileSystemRunStore
  async runDirectory(runId: string): Promise<string | null>;
  ```
  - `append`: Run ディレクトリがなければ `Error("Run not found: <runId>")`。`redactJsonValue(event)` を通してから `{at, event}` を1行で追記（`fs.appendFile`）。`at` 省略時は `now()`。
  - `read`: `fromLine`（0 始まり、既定 0）以降の完全な行（末尾が改行で終わる行）だけを返す。書きかけの最終行は返さず `nextLine` に含めない。JSON として壊れた行は飛ばして `skippedLines` に数える。ファイルがなければ `{ records: [], nextLine: 0, skippedLines: 0 }`。

- [ ] **Step 1: 失敗するテストを書く**（一時ディレクトリの `FileSystemRunStore` で Run を1つ作る）— 2件 append → read で2件・nextLine 2。`fromLine: 1` で1件。最終行が改行なし → その行は返らない。壊れた行1つ → skippedLines 1 で残りは返る。`message.delta` の text に `token=abc123` → 読み出した text に `abc123` が含まれない。存在しない runId に append → `Run not found`。
- [ ] **Step 2: 失敗を確認** — FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 成功を確認** — PASS、`pnpm exec vitest run packages/adapters/src/run-store` 全体も PASS
- [ ] **Step 5: commit** — `feat(adapters): Runのイベントをevents.jsonlに保存する`

### Task 3: `meguribi status`

**Files:**
- Create: `apps/cli/src/commands/status.ts`
- Modify: `apps/cli/src/program.ts`（`status` を登録）
- Test: `apps/cli/src/commands/status.test.ts`

**Interfaces:**
- Consumes: Task 1・2、`createLiveLogRenderer`（core）、`redactDiagnosticText`（adapters）、`FileSystemRunStore`
- Produces:
  ```ts
  export interface StatusCommandOptions { follow?: boolean; agent?: string; json?: boolean; runsRoot?: string }
  export interface StatusCommandDependencies {
    runStore?: RunStore; eventLog?: WorkflowEventLog; now?: () => Date;
    stdout?: (text: string) => void; stderr?: (text: string) => void;
    sleep?: (ms: number) => Promise<void>; abortSignal?: AbortSignal;
  }
  export async function runStatusCommand(runId: string, options: StatusCommandOptions, deps?: StatusCommandDependencies): Promise<{ exitCode: number }>;
  ```
  - `--follow` なし: 1回だけ表示して exit 0。表示（`--json` なし）:
    ```text
    Run: <runId>  (<repository>#<issue>)
    Status: <status>  Step: <currentStep ?? "-">  Fix: <fixAttempts>/<maxFixAttempts>
    Agents:
      <agentLabel> (<role>) <state> <detail ?? ""> <経過>[  応答なし <n>分]
    ```
    経過は `now - since` を `12s` / `3m12s` / `1h05m` 形式。`--agent` があればその1件だけ。活動がなければ `Agents: (no agent events yet)`。`--json` は `{ state, activities }` を1行の JSON で出す。
  - `--follow`: 既存イベントをすべて `createLiveLogRenderer({ mode: "stream", color, redact: redactDiagnosticText, onlyProfileId: options.agent })` で stdout に流し、その後 1 秒ごとに `read(runId, nextLine)` で追記分を流す。終了条件は Global Constraints のとおり。`--agent` の ID のイベントが1件もない間は、最初に1回だけ `この Run に <id> のイベントはまだありません。待機中…` を stderr に出す。色は stdout が TTY かつ `NO_COLOR` 未設定のときだけ。
  - `skippedLines` が 0 より大きくなったら、`warning: skipped <n> malformed event line(s)` を stderr に1回だけ出す。
  - 存在しない runId: stderr に `Run not found: <runId>` と `Next: meguribi status に渡す runId は meguribi run / resume の出力の "Run:" 行で確認できます`、exit 1。

- [ ] **Step 1: 失敗するテストを書く**（runStore / eventLog は in-memory fake、sleep は即時解決、abortSignal で打ち切り）— 1回表示の書式、`--agent` の絞り込み、`--json`、存在しない runId、`--follow` で途中に追記されたイベントが流れて Run が `awaiting_human` になったら exit 0、`--agent` に該当なしの待機メッセージ、壊れた行の警告。
- [ ] **Step 2: 失敗を確認** — FAIL
- [ ] **Step 3: 実装とコマンド登録**（`meguribi status <runId> [--follow] [--agent <profileId>] [--json]`）
- [ ] **Step 4: 成功を確認** — `pnpm exec vitest run apps/cli/src` / PASS
- [ ] **Step 5: commit** — `feat(cli): meguribi statusでRunの進捗とエージェントの活動を表示`

### Task 4: YAML のワークフロー定義と `workflow validate`

**Files:**
- Create: `packages/config/src/workflow-definition.ts`
- Create: `apps/cli/src/commands/workflow.ts`
- Modify: `packages/config/src/index.ts`、`apps/cli/src/program.ts`
- Test: `packages/config/src/workflow-definition.test.ts`、`apps/cli/src/commands/workflow.test.ts`

**Interfaces:**
- Consumes: `WorkflowDefinition` / `validateWorkflowDefinition` / `STEP_KINDS`（core）
- Produces:
  ```ts
  export class WorkflowDefinitionParseError extends Error { readonly path: string; readonly issues: readonly string[] }
  export function parseWorkflowDefinition(yamlText: string, sourcePath: string): WorkflowDefinition;
  export async function loadRepositoryWorkflows(repositoryPath: string): Promise<{ path: string; definition?: WorkflowDefinition; error?: string }[]>;
  export async function runWorkflowValidateCommand(file: string, deps?: { stdout?: (t: string) => void; stderr?: (t: string) => void; readFile?: (p: string) => Promise<string> }): Promise<{ exitCode: number }>;
  ```
  - YAML の形は設計書 §6.5 の例（`name`、`steps[]` に `id` / `kind` / `then` / `of` / `onFailure` / `onChangesRequired`）。Valibot の `strictObject` で検証し、知らないキー・知らない `kind` は `WorkflowDefinitionParseError`（issues に `steps.2.kind` のようなパス）。
  - `loadRepositoryWorkflows` は `<repositoryPath>/.meguribi/workflows/*.yml` と `*.yaml` を名前順に読む。ディレクトリがなければ `[]`。1ファイルの失敗で全体を止めず、そのファイルに `error` を付けて返す。
  - `meguribi workflow validate <file>`: parse → `validateWorkflowDefinition`。問題なし → `OK: <name> (<n> steps)` で exit 0。問題あり → 1行1件で `<code> <stepId ?? "-">: <message>` を stderr に出して exit 1。
  - 組み込み定義の一覧（`workflow list`）は後半の Task 6 で行う。

- [ ] **Step 1: 失敗するテストを書く** — 設計書 §6.5 の `discuss-to-pr` 例の YAML が parse できて validate で `[]`。`kind: deploy` → parse エラーで path に `steps.0.kind`。`publish` の前に `review` がない定義 → validate コマンドが `publish_requires_verify_and_review` を出して exit 1。`loadRepositoryWorkflows` が壊れたファイルにだけ error を付ける。
- [ ] **Step 2: 失敗を確認** — FAIL
- [ ] **Step 3: 実装とコマンド登録**
- [ ] **Step 4: 成功を確認** — PASS
- [ ] **Step 5: commit** — `feat(cli): YAMLのワークフロー定義を読み込みworkflow validateで検査`

---

## 後半（P2a 第2段が main に入ってから着手する）

### Task 5: `run` / `resume` がイベントを書き出す

**Files:**
- Modify: `apps/cli/src/commands/run.ts`、`apps/cli/src/wiring/create-delivery-deps.ts`
- Test: `apps/cli/src/commands/run.events.test.ts`

- [ ] `run` / `resume` は `FileSystemWorkflowEventLog` を作り、`DeliveryDependencies.onWorkflowEvent`（P2a）と `onAgentEvent`（P1）の両方を、Run 作成後の runId で `append` する（`onStateChange` の初回で runId を得る。append の失敗は結果に影響させず、stderr に1回だけ警告）。ライブログ表示（既存の `withLiveLog`）は従来どおり。
- [ ] テスト: fake の delivery で `workflow.started` → `workflow.step.started`（plan）… → `workflow.finished` と、実装担当の `agent.event` が `events.jsonl` に順に入る。append が throw しても `run` の exitCode と結果が変わらない。
- [ ] commit — `feat(run): Runのイベントをevents.jsonlに記録`

### Task 6: `step.progress` と `workflow list`

**Files:**
- Modify: `packages/core/src/workflow-engine/events.ts`（`{ type: "step.progress"; runId; stepId; label; current; max?; at }` を追加）
- Modify: `packages/core/src/workflow/delivery-steps.ts`（P2a で作られるファイル）
- Modify: `apps/cli/src/commands/workflow.ts`
- Test: `packages/core/src/workflow/delivery-steps.progress.unit.test.ts`、`apps/cli/src/commands/workflow.test.ts`

- [ ] `fix` 工程の開始時に `{ label: "fix", current: fixAttempts, max: maxFixAttempts }`、`verify` 工程で各検証コマンドの完了ごとに `{ label: "verify", current: 完了数, max: コマンド数 }` を `onWorkflowEvent` に出す。**delivery の振る舞いトレース（golden）は変わらないこと**（イベントは trace の対象外）。
- [ ] `createLiveLogRenderer` に `step.progress` の表示（`  · <label> <current>/<max>`）を足す。
- [ ] `meguribi workflow list [--repo-path <path>]`: 組み込み `delivery`（`createDeliveryWorkflow(2)` の工程 ID 列）と `loadRepositoryWorkflows` の結果を表示。
- [ ] commit — `feat(workflow): 工程の進捗イベントとworkflow listを追加`

### Task 7: ドキュメント

- [ ] `docs/ja` / `docs/en` の cli-and-integrations に `status`、`workflow validate|list`、`events.jsonl` の形式、`--follow --agent` を Ghostty / tmux の分割画面で使う例を追記。architecture に `events.jsonl` と `deriveAgentActivity` を追記。
- [ ] 全体検証 `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [ ] commit — `docs: Runのイベントログとstatusコマンドを反映`
