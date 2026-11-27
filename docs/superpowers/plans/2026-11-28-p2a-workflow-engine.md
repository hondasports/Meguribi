# P2a ワークフローエンジンと delivery の移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工程種別が閉じたワークフローを逐次実行するエンジンを core に作り、既存の `runDelivery` / `resumeDelivery` をその上の組み込みワークフロー `delivery` へ、外から見た振る舞いを一切変えずに移す。

**Architecture:** まず現行 delivery の振る舞い（状態遷移・依存の呼び出し順・結果）を記録する「振る舞いトレース」を既存 17 場面で作り、移植後も完全一致することを保証する。エンジンは定義（`WorkflowDefinition`）・定義の静的検査・実行ループ（`then` / `onFailure` / `onChangesRequired` と訪問回数の上限）・工程状態の保存・`WorkflowEvent` 通知だけを持つ汎用部品で、delivery 固有の判断は工程ハンドラーに閉じ込める。前処理（Issue 取得〜worktree、MCP 確認）は今回は `runDelivery` 内に残す。

**Tech Stack:** TypeScript strict、Valibot、Vitest、既存 fakes（`packages/adapters/src/fakes/delivery-fakes.ts`）。

**Spec:** `docs/superpowers/specs/2026-11-27-multi-agent-orchestration-design.md`（§6.5、§6.6 の `WorkflowEvent`、§8 P2）

## Global Constraints

- Node.js 24、pnpm、TypeScript strict。新しい npm 依存は追加しない（YAML 読み込みは P2b。今回の定義はコードで組み立てる）。
- **既存の delivery fixture テスト（`packages/adapters/src/workflow/delivery.fixture.test.ts`、`delivery.live-log.fixture.test.ts`、`delivery.process-boundary.integration.test.ts`）を変更せずに通す。**
- **Task 1 の振る舞いトレース（golden）は Task 1 で現行コードから一度だけ生成して commit し、以降のタスクで再生成・編集しない。** 一致しなくなったら移植側を直す。
- 工程種別（閉じた集合）: `discuss`, `approve`, `specify`, `plan`, `implement`, `fix`, `verify`, `review`, `publish`。P2a でハンドラーを実装するのは `plan` / `implement` / `verify` / `review` / `fix` / `publish` のみ。
- 制御は逐次と、上限付きの遷移（`onFailure` / `onChangesRequired` の `{ goto, max }`）と `then` のみ。条件式・変数・任意コマンドはない。
- 工程状態は RunStore の成果物 `steps/<stepId>.json` に保存する。トレース比較からは `steps/` 配下の `saveArtifact` 呼び出しを除外する。
- 既存の `RunState.status` / `currentStep` / `completedSteps` の更新はハンドラーが従来どおり行う（エンジンは触らない）。
- 各タスクの commit は Conventional Commits。末尾に `Co-Authored-By` を付ける。

## Review Focus

- 検証失敗 → 修正 → それでも失敗、のとき理由が `"verification failed after fix attempts"` で `completedSteps` に `implementation_blocked` が入る／レビュー経路では `"review still requires changes after fix attempts"` で `completedSteps` に入らない、という非対称を移植で揃えてしまう → Task 1 のトレースで検出（Task 5 で一致を確認）。
- 検証経路の修正の後に、改めて `reviewing` 状態でレビューを1回行う（修正内部のレビューとは別）という現行の動き → 同上。
- resume が `reviewing` から再開するとき、既存の `verification.json` を再利用して検証を再実行しない → Task 6 のトレースで検出。
- ハンドラーが同じ工程へ戻り続けるループ → エンジンの訪問上限で `loop_limit` として止まる（Task 3 のテスト）。
- 定義の誤り（存在しない `goto`、`max` なし、ID 重複、`publish` の前に `verify` / `review` がない）→ 実行前に静的検査で拒否（Task 2 のテスト）。

---

### Task 1: 現行 delivery の振る舞いトレース（characterization）

**Files:**
- Create: `packages/adapters/src/workflow/delivery-trace.ts`（トレース記録用の依存ラッパー）
- Create: `packages/adapters/src/workflow/delivery.trace.fixture.test.ts`
- Create: `packages/adapters/src/workflow/__golden__/delivery-traces.json`（Step 3 で生成）

**Interfaces:**
- Produces:
  ```ts
  export interface DeliveryTrace {
    states: Array<Pick<RunState, "status" | "currentStep" | "completedSteps" | "fixAttempts" | "pullRequestNumber"> & { lastErrorCode?: string; lastErrorMessage?: string }>;
    calls: string[];   // 例: "github.getIssue", "codex.createPlan", "implementer.implement", "verifier.verify", "runStore.saveArtifact:plan.json"
    result: Pick<DeliveryResult, "status" | "published" | "reasons" | "pullRequestNumber">;
  }
  export function withDeliveryTrace(deps: DeliveryDependencies): { deps: DeliveryDependencies; trace: DeliveryTrace };
  ```
  - `withDeliveryTrace` は `github` / `git` / `codex` / `implementer` / `verifier` / `policy` / `runStore` の各メソッドを包み、呼ばれた順に `"<port>.<method>"` を `calls` に積む（`runStore.saveArtifact` と `readArtifact` だけは `:<name>` を付ける。`steps/` で始まる name は記録しない）。`onStateChange` で `states` を積む。`runStore.update` / `load` / `loadLatest` / `create` / `acquireLock` / `releaseLock` も記録する。
  - 時刻・runId・sessionId などの非決定的な値は記録しない。

- [ ] **Step 1: トレーステストを書く**
  `delivery.fixture.test.ts` の 17 場面と同じ入力・fake 設定（`createFakeDeliveryDeps` のオプションと `baseInput` の上書き、resume 場面の事前状態）を、`it.each` で回せる表 `scenarios: Array<{ name: string; run: () => Promise<DeliveryTrace> }>` として再現する。各場面の名前は既存 `it(...)` の名前と同じにする。テスト本体:

  ```ts
  const goldenPath = new URL("./__golden__/delivery-traces.json", import.meta.url);
  it.each(scenarios)("$name keeps the recorded delivery trace", async ({ name, run }) => {
    const trace = await run();
    if (process.env.MEGURIBI_UPDATE_GOLDEN === "1") { recordGolden(goldenPath, name, trace); return; }
    expect(trace).toEqual(readGolden(goldenPath)[name]);
  });
  ```
- [ ] **Step 2: golden がないので失敗することを確認** — Run: `pnpm exec vitest run packages/adapters/src/workflow/delivery.trace.fixture.test.ts` / Expected: FAIL（golden file なし）
- [ ] **Step 3: 現行コードのまま golden を生成** — Run: `MEGURIBI_UPDATE_GOLDEN=1 pnpm exec vitest run packages/adapters/src/workflow/delivery.trace.fixture.test.ts` / Expected: `__golden__/delivery-traces.json` に 17 キー
- [ ] **Step 4: 生成した golden と一致することを確認** — Run: `pnpm exec vitest run packages/adapters/src/workflow/delivery.trace.fixture.test.ts` を2回 / Expected: 2回とも 17 passed（決定的であること）
- [ ] **Step 5: commit** — `test(workflow): 現行deliveryの振る舞いトレースを記録`

### Task 2: ワークフロー定義と静的検査

**Files:**
- Create: `packages/core/src/workflow-engine/definition.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/workflow-engine/definition.unit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const STEP_KINDS = ["discuss", "approve", "specify", "plan", "implement", "fix", "verify", "review", "publish"] as const;
  export type StepKind = (typeof STEP_KINDS)[number];
  export interface StepTransition { goto: string; max: number }
  export interface StepDefinition {
    id: string; kind: StepKind;
    then?: string;                       // continue 時の次の工程（省略時は定義順の次）
    of?: string;                         // この工程が対象にする工程（approve の承認対象、fix の修正元）
    onFailure?: StepTransition;
    onChangesRequired?: StepTransition;
  }
  export interface WorkflowDefinition { name: string; steps: readonly StepDefinition[] }
  export interface WorkflowDefinitionIssue { code: WorkflowDefinitionIssueCode; stepId?: string; message: string }
  export type WorkflowDefinitionIssueCode =
    | "duplicate_step_id" | "unknown_step_reference" | "missing_max" | "invalid_max"
    | "publish_requires_verify_and_review" | "implement_requires_verify" | "discuss_requires_approve";
  export function validateWorkflowDefinition(definition: WorkflowDefinition): WorkflowDefinitionIssue[];
  export class WorkflowDefinitionError extends Error { readonly issues: readonly WorkflowDefinitionIssue[] }
  export function assertValidWorkflowDefinition(definition: WorkflowDefinition): void;
  ```
  検査規則（設計書 §6.5）:
  - ID 重複 → `duplicate_step_id`。`then` / `of` / `goto` が存在しない ID → `unknown_step_reference`。
  - `onFailure` / `onChangesRequired` に `max` がない → `missing_max`、`max` が 1 未満の整数でない → `invalid_max`。
  - 定義順で最初の `publish` より前に `verify` と `review` が両方ない → `publish_requires_verify_and_review`。
  - `implement` の後（定義順）に `verify` がない → `implement_requires_verify`。
  - `discuss` があり、それより後で最初の `implement` / `fix` / `publish` までの間に `kind: "approve"` かつ `of` がその `discuss` の工程がない → `discuss_requires_approve`。

- [ ] **Step 1: 失敗するテストを書く** — 正しい定義（Task 5 の `delivery` と同じ形）で `[]`。上記7コードそれぞれを1件ずつ発生させる最小定義で、その code を含むこと。`assertValidWorkflowDefinition` が `WorkflowDefinitionError` を投げ、`issues` を持つこと。
- [ ] **Step 2: 失敗を確認** — `pnpm exec vitest run packages/core/src/workflow-engine/definition.unit.test.ts` / FAIL
- [ ] **Step 3: 実装** — 純粋関数。issues はすべて集めて返す（最初の1件で止めない）。
- [ ] **Step 4: 成功を確認** — PASS
- [ ] **Step 5: commit** — `feat(core): ワークフロー定義と静的検査を追加`

### Task 3: 実行エンジン

**Files:**
- Create: `packages/core/src/workflow-engine/engine.ts`
- Create: `packages/core/src/workflow-engine/events.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/workflow-engine/engine.unit.test.ts`

**Interfaces:**
- Consumes: Task 2 の型と `assertValidWorkflowDefinition`、`LiveLogEvent`（`packages/core/src/live-log.ts`）
- Produces:
  ```ts
  // events.ts
  export type WorkflowEvent =
    | LiveLogEvent
    | { type: "workflow.started"; runId: string; workflow: string; at: string }
    | { type: "workflow.step.started"; runId: string; stepId: string; kind: StepKind; visit: number; at: string }
    | { type: "workflow.step.completed"; runId: string; stepId: string; kind: StepKind; outcome: StepOutcome["type"]; at: string }
    | { type: "workflow.step.failed"; runId: string; stepId: string; kind: StepKind; message: string; at: string }
    | { type: "workflow.finished"; runId: string; workflow: string; outcome: WorkflowRunResult<unknown>["type"]; at: string };

  // engine.ts
  export type StepOutcome<R = unknown> =
    | { type: "continue" } | { type: "failure" } | { type: "changes_required" } | { type: "stop"; result: R };
  export interface StepHandlerContext<C> { step: StepDefinition; context: C; visit: number }
  export type StepHandler<C, R = unknown> = (ctx: StepHandlerContext<C>) => Promise<StepOutcome<R>>;
  export interface StepStateRecord { stepId: string; kind: StepKind; status: "running" | "completed" | "failed"; visit: number; outcome?: StepOutcome["type"]; startedAt: string; finishedAt?: string }
  export interface StepStateStore { save(record: StepStateRecord): Promise<void> }
  export type WorkflowRunResult<R> =
    | { type: "stopped"; stepId: string; result: R }
    | { type: "completed" }
    | { type: "loop_limit"; stepId: string; transition: "onFailure" | "onChangesRequired" }
    | { type: "unhandled"; stepId: string; outcome: "failure" | "changes_required" };
  export interface RunWorkflowInput<C, R> {
    runId: string; definition: WorkflowDefinition;
    handlers: Partial<Record<StepKind, StepHandler<C, R>>>;
    context: C; startAt?: string;
    stepStore?: StepStateStore; onEvent?: (event: WorkflowEvent) => void; now?: () => Date;
  }
  export async function runWorkflow<C, R>(input: RunWorkflowInput<C, R>): Promise<WorkflowRunResult<R>>;
  export class MissingStepHandlerError extends Error { readonly kind: StepKind }
  ```
  実行規則:
  - 開始時に `assertValidWorkflowDefinition`。`startAt` 省略時は先頭の工程。`startAt` が存在しない ID → `unknown_step_reference` の `WorkflowDefinitionError`。
  - 工程ごとに、訪問回数（その工程に入った回数、1 始まり）を数え、`stepStore.save`（running）→ `workflow.step.started` → ハンドラー → `stepStore.save`（completed）→ `workflow.step.completed`。ハンドラーが throw したら `stepStore.save`（failed）と `workflow.step.failed` を出してから同じ例外を投げ直す。
  - `continue` → `then` があればそこ、なければ定義順の次、最後なら `completed`。
  - `failure` / `changes_required` → 対応する遷移がなければ `unhandled`。あれば、その遷移を通った回数（遷移ごとに数える）が `max` 未満なら `goto` 先へ、`max` に達していれば `loop_limit`。
  - `stop` → `stopped`。
  - 終了時に `workflow.finished`。`onEvent` の例外は握りつぶす（進捗表示が結果を変えないため）。
  - ハンドラーがない kind に入ったら `MissingStepHandlerError`。

- [ ] **Step 1: 失敗するテストを書く**（ハンドラーは記録用の fake）
  - 3工程が定義順に1回ずつ実行され `completed`。`then` で順序を飛ばせる。
  - `failure` → `onFailure.goto` へ移り、`max: 2` なら2回まで移り、3回目の `failure` で `loop_limit`（`transition: "onFailure"`）。
  - `changes_required` で遷移なし → `unhandled`。
  - `stop` の `result` がそのまま返る。`startAt` で途中から始められる。
  - ハンドラーが throw → 同じ例外が投げ直され、`stepStore` に `failed` が保存され、`workflow.step.failed` が出る。
  - `onEvent` が throw しても結果が変わらない。
  - 発行イベントの type 列が `workflow.started` → `workflow.step.started` → `workflow.step.completed` … → `workflow.finished`。
- [ ] **Step 2: 失敗を確認** — `pnpm exec vitest run packages/core/src/workflow-engine/engine.unit.test.ts` / FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 成功を確認** — PASS
- [ ] **Step 5: commit** — `feat(core): ワークフロー実行エンジンを追加`

### Task 4: 工程状態の保存先

**Files:**
- Create: `packages/core/src/workflow-engine/run-store-step-state.ts`
- Test: `packages/core/src/workflow-engine/run-store-step-state.unit.test.ts`

**Interfaces:**
- Consumes: `RunStore`（`packages/core/src/delivery.ts`）、`StepStateStore`（Task 3）
- Produces: `export function createRunStoreStepStateStore(runStore: RunStore, runId: string): StepStateStore;` — `save(record)` は `runStore.saveArtifact(runId, \`steps/${record.stepId}.json\`, record)`。

- [ ] **Step 1: 失敗するテスト** — `createMemoryRunStore`（`@meguribi/adapters` の fakes ではなく、テスト内の最小 fake `RunStore`）で `save` 後に `readArtifact(runId, "steps/verify.json")` が record と等しい。
- [ ] **Step 2〜4: RED → 実装 → GREEN**
- [ ] **Step 5: commit** — `feat(core): 工程状態をRunStoreへ保存する`
- 注: `FileSystemRunStore` の `sanitizeArtifactName` はサブディレクトリ付きの名前を受け付け、`atomicWriteFile` が親ディレクトリを作る（確認済み）。`packages/adapters/src/run-store/filesystem-run-store.unit.test.ts` に、`steps/verify.json` を保存して読み戻せることのテストを1件足す（実装の変更は不要）。

### Task 5: `runDelivery` をエンジンへ移植

**Files:**
- Create: `packages/core/src/workflow/delivery-definition.ts`
- Create: `packages/core/src/workflow/delivery-steps.ts`
- Modify: `packages/core/src/workflow/delivery.ts`（`runDelivery` の計画以降と `runVerifyReviewPublish` / `maybeFix` をハンドラーへ移す）
- Modify: `packages/core/src/delivery.ts`（`DeliveryDependencies` に `onWorkflowEvent?: (event: WorkflowEvent) => void`）
- Test: Task 1 のトレーステストと既存 fixture テスト（変更しない）、新規 `packages/core/src/workflow/delivery-definition.unit.test.ts`

**Interfaces:**
- Consumes: Task 2〜4
- Produces:
  ```ts
  export const DELIVERY_WORKFLOW_NAME = "delivery";
  export function createDeliveryWorkflow(maxFixAttempts: number): WorkflowDefinition;
  export interface DeliveryRunContext {
    deps: DeliveryDependencies; delivery: RunDeliveryInput | ResumeDeliveryInput;
    state: RunState; issue: IssueRecord;
    plan?: PlanArtifact; implementation?: ImplementationResult;
    verification?: VerificationResult; review?: ReviewArtifact;
    /** resume 用: true のとき verify は既存の verification.json を再利用する（現行の startFrom !== "verifying"） */
    reuseVerification: boolean;
  }
  export function createDeliveryStepHandlers(): Partial<Record<StepKind, StepHandler<DeliveryRunContext, DeliveryResult>>>;
  ```
  組み込み定義（この形・この ID で固定）:

  ```ts
  { name: "delivery", steps: [
    { id: "plan", kind: "plan" },
    { id: "implement", kind: "implement" },
    { id: "verify", kind: "verify", onFailure: { goto: "fix-after-verify", max: 1 } },
    { id: "review", kind: "review", then: "publish", onChangesRequired: { goto: "fix-after-review", max: 1 } },
    { id: "fix-after-verify", kind: "fix", of: "verify", then: "review" },
    { id: "fix-after-review", kind: "fix", of: "review", then: "publish", onChangesRequired: { goto: "fix-after-review", max: maxFixAttempts + 1 } },
    { id: "publish", kind: "publish" },
  ] }
  ```

  ハンドラーは現行コードの該当部分を**そのまま**移す（`mark` の引数、成果物名、理由の文字列、中断確認の位置を変えない）。対応:

  | 工程 | 現行コードの範囲 | outcome |
  |---|---|---|
  | `plan` | `runDelivery` の `planning` 開始から `currentStep: "implementing"` の mark と直後の中断確認（`"cancelled before implementation"`）まで | 中断なら `stop`、他は `continue` |
  | `implement` | `status: "implementing"` から `currentStep: "implementation_completed"` の mark まで（cancelled / timed_out / blocked の各 return を含む） | 各 return は `stop`、成功は `continue` |
  | `verify` | `runVerifyReviewPublish` の冒頭〜検証成果物の保存と `"cancelled before review"` の確認まで。`reuseVerification` が true かつ既存の `verification.json` があれば再実行しない | 成功 `continue`、失敗 `failure`、中断 `stop` |
  | `fix`（`of: "verify"`） | `needsFixFromVerify` の分岐（`maybeFix` 1回と、その後の `"verification failed after fix attempts"` の blocked） | 中断・blocked は `stop`、それ以外 `continue` |
  | `review` | `status: "reviewing"` の mark からレビュー成果物の保存・`reviewing` の追加まで | `changes_required` なら `changes_required`、他は `continue` |
  | `fix`（`of: "review"`） | `while (review.status === "changes_required")` の1周分 | 周回継続なら `changes_required`、blocked・中断は `stop`、抜けたら `continue` |
  | `publish` | `"cancelled before publish"` の確認から最後の `return`（published）まで | 常に `stop` |

  `runDelivery` は前処理（Issue 取得〜`currentStep: "planning"` の mark）を従来どおり行い、その後 `runWorkflow({ runId, definition: createDeliveryWorkflow(input.maxFixAttempts), handlers, context, stepStore: createRunStoreStepStateStore(...), onEvent: deps.onWorkflowEvent })` を呼ぶ。結果の扱い: `stopped` → その `result`。`completed` / `unhandled` / `loop_limit` → 現行の `catch` と同じ経路に乗るよう `Error("delivery workflow ended without a result: <type>")` を投げる。

- [ ] **Step 1: 失敗するテスト** — `delivery-definition.unit.test.ts`: `validateWorkflowDefinition(createDeliveryWorkflow(2))` が `[]`、工程 ID 列が上の順。
- [ ] **Step 2: 失敗を確認** — FAIL
- [ ] **Step 3: 定義とハンドラーを作り、`runDelivery` を移植する**
- [ ] **Step 4: 一致を確認** — Run: `pnpm exec vitest run packages/adapters/src/workflow packages/core/src/workflow` / Expected: トレース 17 件を含めすべて PASS（`resume` の場面は Task 6 まで旧経路のままなので PASS する）
- [ ] **Step 5: commit** — `refactor(workflow): runDeliveryをワークフローエンジンへ移植`

### Task 6: `resumeDelivery` をエンジンへ移植

**Files:**
- Modify: `packages/core/src/workflow/delivery.ts`（`resumeDelivery` の `runVerifyReviewPublish` 呼び出し部分）
- Test: Task 1 のトレース、既存 fixture

**Interfaces:**
- Consumes: Task 5

- [ ] **Step 1: 移植前のトレースが通っていることを確認** — Run: `pnpm exec vitest run packages/adapters/src/workflow/delivery.trace.fixture.test.ts` / PASS
- [ ] **Step 2: 移植** — 現行の `startFrom` 判定はそのまま残し、`"verifying"` → `startAt: "verify"`・`reuseVerification: false`、`"reviewing"` → `startAt: "verify"`・`reuseVerification: true`、`"publishing"` → `startAt: "publish"` で `runWorkflow` を呼ぶ。`"publishing"` で検証・レビューの成果物がないときは現行と同じエラー（`"verification and review artifacts are required before publish"`）を投げる。
- [ ] **Step 3: 一致を確認** — 上と同じコマンドと `pnpm exec vitest run packages/adapters/src/workflow` / PASS
- [ ] **Step 4: `runVerifyReviewPublish` と `maybeFix` が未使用なら削除し、型チェック** — `pnpm typecheck` / exit 0
- [ ] **Step 5: commit** — `refactor(workflow): resumeDeliveryをワークフローエンジンへ移植`

### Task 7: 仕上げとドキュメント

**Files:**
- Modify: `docs/ja/architecture.md`、`docs/en/architecture.md`（ワークフローエンジンの節を「計画中」から「delivery は組み込みワークフロー `delivery` として実装済み。YAML の読み込みと `workflow` コマンドは P2b」に更新し、組み込み定義の工程 ID 列を載せる）

- [ ] **Step 1: 全体検証** — Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` / Expected: lint は warning 0、typecheck / build は exit 0、test の失敗は着手前の main と同じ既知の環境依存失敗のみ
- [ ] **Step 2: ドキュメントを日英で更新**
- [ ] **Step 3: commit** — `docs: deliveryの組み込みワークフロー化を反映`
