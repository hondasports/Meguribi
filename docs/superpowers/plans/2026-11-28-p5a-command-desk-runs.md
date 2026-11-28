# P5a Command Desk の Run 画面（一覧・工程・活動・エージェント別ペイン） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Command Desk（`apps/web`）で、RunStore にある Run の一覧・工程の進み具合・エージェントの活動状態を表示し、エージェントごとのペインと全体ログにライブログを流す。CLI から開始した Run もそのまま追える。

**Architecture:** サーバー（`apps/web/server`）が RunStore と `events.jsonl` を読む読み取り専用の API と SSE を持つ。ライブログの整形はサーバーで `createLiveLogRenderer`（core）を使い、CLI と同じ見た目の文字列を、全体用とエージェント別（`onlyProfileId`）に分けて送る。画面側の状態の組み立て（工程の並び・ペインの並び・応答なし表示）は、Vue から切り離した純粋な TypeScript モジュールに置いてテストする。議論ビュー・承認画面・発言挿入は P5b（P3 の後）。

**Tech Stack:** Vue 3、Vite、Node の `http`（既存のサーバー）、SSE、TypeScript strict、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-27-multi-agent-orchestration-design.md`（§6.6「画面」「進捗とエージェントの活動」、§6.7 `meguribi desk`）

## Global Constraints

- 新しい外部 npm 依存は追加しない。`apps/web` に workspace 依存（`@meguribi/core`、`@meguribi/adapters`）を足すのはよい（lockfile は workspace link の追加だけ）。
- サーバーは従来どおり `127.0.0.1` にだけ bind し、認証は持たない。今回足す API はすべて読み取り専用（GET）。Run の状態やファイルを書き換える API は作らない。
- 既存の Command Desk の機能（コマンド実行と `/api/runs/:id/events` の出力ストリーム）は変えない。新しい API は `/api/run-store/...` に置き、名前をぶつけない。
- RunStore の場所は CLI と同じ解決（`XDG_DATA_HOME` / Windows は `LOCALAPPDATA` / それ以外は `~/.local/share/meguribi`）。`MEGURIBI_RUNS_ROOT` 環境変数があればそれを優先する（テスト用）。
- 画面に出すテキストは、ライブログと同じ redaction を通したものだけ（サーバーで `redactDiagnosticText` を通す）。
- 追従は 1 秒ごと。応答なしの閾値は 120000ms（`deriveAgentActivity` の既定）。
- `apps/web/server/**/*.test.ts` を CI の `pnpm test`（ルートの Vitest）で実行されるようにする（今は実行されていない）。
- 各タスクの commit は Conventional Commits。末尾に `Co-Authored-By` を付ける。

## Review Focus

- `events.jsonl` がまだない Run（開始直後）→ 一覧と状態は出て、ペインは空、エラーにしない（Task 2・4 にテスト）。
- SSE のクライアントが切断した後も 1 秒ごとの読み込みが続く → 切断時にタイマーを止める（Task 2 にテスト）。
- runId にパス区切りや `..` を含めた要求 → 400（RunStore の外を読まない）（Task 2 にテスト）。
- 同じ Run を2つのタブで開く → それぞれ独立に最初から流れる（Task 2 にテスト）。
- 参加エージェントが増えていく Run（計画役 → 実装役 → レビュー役）→ 新しいエージェントのペインが出た時点で追加され、既存のペインの内容は消えない（Task 3 にテスト）。

---

### Task 1: CI で web サーバーのテストを実行する／Run の一覧

**Files:**
- Modify: `vitest.config.ts`（`test.include` に `"apps/*/server/**/*.test.ts"` を追加）
- Modify: `packages/adapters/src/run-store/filesystem-run-store.ts`（`listRecent(limit)` を追加）
- Modify: `packages/core/src/index.ts`（`createDeliveryWorkflow` を末尾で export）
- Test: `packages/adapters/src/run-store/filesystem-run-store.unit.test.ts`（追記）

**Interfaces:**
- Produces:
  ```ts
  // FileSystemRunStore
  async listRecent(limit?: number /* 既定 50、最大 200 */): Promise<RunState[]>; // runs/ 配下の state.json をすべて読み、updatedAt の新しい順。壊れた state.json は飛ばす
  ```
- [ ] **Step 1: 失敗するテスト** — 3つの Run を作って `update` で updatedAt をずらし、新しい順に返る。`limit: 2` で2件。壊れた state.json があっても残りは返る。
- [ ] **Step 2: RED を確認** — FAIL
- [ ] **Step 3: 実装と vitest 設定の変更**
- [ ] **Step 4: GREEN** — 上のテストと、`pnpm test` で `apps/web/server/command-specs.test.ts` が実行されて PASS すること（実行件数に入ることを確認）
- [ ] **Step 5: commit** — `feat(adapters): RunStoreから最近のRunを一覧する`

### Task 2: Run を読む API と SSE

**Files:**
- Create: `apps/web/server/run-store-api.ts`
- Modify: `apps/web/server/index.ts`（ルーティングを追加）、`apps/web/package.json`（`@meguribi/core` / `@meguribi/adapters` を `workspace:*` で dependencies に、`"predev": "pnpm --filter @meguribi/web^... build"` を追加）
- Test: `apps/web/server/run-store-api.test.ts`

**Interfaces:**
- Consumes: `FileSystemRunStore`（`listRecent` / `load` / `readArtifact` / `runDirectory`）、`FileSystemWorkflowEventLog`、`deriveAgentActivity`、`createLiveLogRenderer`、`redactDiagnosticText`、`createDeliveryWorkflow`
- Produces:
  ```ts
  export interface RunSummary { runId: string; repository: string; issueNumber: number; command: RunState["command"]; status: RunState["status"]; currentStep?: string; updatedAt: string; pullRequestNumber: number | null }
  export interface RunDetail {
    state: RunState;
    pipeline: Array<{ stepId: string; kind: string; status: "pending" | "running" | "completed" | "failed"; visit: number }>;
    activities: AgentActivity[];
  }
  export interface RunStoreApiOptions { runStore: FileSystemRunStore; eventLog: WorkflowEventLog; now?: () => Date; pollMs?: number /* 既定 1000 */ }
  export function createRunStoreApi(options: RunStoreApiOptions): {
    handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>; // 処理したら true
  };
  ```
  ルート:
  - `GET /api/run-store/runs?limit=50` → `RunSummary[]`
  - `GET /api/run-store/runs/:runId` → `RunDetail`。`pipeline` は、`command` が `run` / `resume` なら `createDeliveryWorkflow(state.maxFixAttempts)` の工程 ID 順に、`workflow.step.started` / `completed` / `failed` イベントから各工程の最新の状態と訪問回数を当てはめる（イベントのない工程は `pending`）。それ以外の `command` はイベントに出た順に並べる。`activities` は全イベントから `deriveAgentActivity`。
  - `GET /api/run-store/runs/:runId/stream` → SSE。接続時に既存イベントをすべて送り、以降 `pollMs` ごとに追記分を送る。送るイベント:
    - `event: log` / `data: { "pane": "all" | "<profileId>", "text": "<整形済みの文字列>" }` — `createLiveLogRenderer({ mode: "stream", color: false, redact: redactDiagnosticText })` を全体用に1つ、`agent.event` / `step.started` に出てきた profileId ごとに `onlyProfileId` 付きで1つずつ持ち、空でない出力だけ送る。
    - `event: detail` / `data: RunDetail` — 追記があったときと、5回に1回（応答なし表示の更新のため）。
    - `event: end` — Run の `status` が `awaiting_human` / `blocked` / `failed` / `cancelled` / `timed_out` / `interrupted` / `completed` になり、最後まで送り終えたら送って閉じる。
  - runId が `^[A-Za-z0-9._-]+$` に合わない、または `..` を含む → 400。存在しない → 404。
  - クライアント切断（`req.on("close")`）でタイマーを止める。
- [ ] **Step 1: 失敗するテスト**（一時ディレクトリの `FileSystemRunStore` と実ファイルの `events.jsonl`。HTTP はテスト用に `http.createServer` で `handle` を包み、実際にリクエストする）— 一覧・詳細・pipeline の当てはめ・`events.jsonl` なしで空・SSE が既存イベントを送ってから追記分を送る・`end` で閉じる・切断でタイマーが止まる（`pollMs` を小さくし、切断後に読み込み回数が増えないこと）・不正な runId で 400。
- [ ] **Step 2〜4: RED → 実装 → GREEN**
- [ ] **Step 5: commit** — `feat(web): RunStoreのRunとイベントを読むAPIを追加`

### Task 3: 画面の状態を組み立てる純粋モジュール

**Files:**
- Create: `apps/web/src/run-view.ts`
- Test: `apps/web/src/run-view.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PaneState { id: string /* "all" または profileId */; title: string; text: string; active: boolean; stalled: boolean; stateLabel: string }
  export interface RunViewState { detail?: RunDetail; panes: PaneState[]; selectedPane: string /* "agents" | "all" */ }
  export function createRunViewState(): RunViewState;
  export function applyLog(state: RunViewState, chunk: { pane: string; text: string }): RunViewState;   // 追記。1ペイン最大 200,000 文字、超えたら先頭から捨てる
  export function applyDetail(state: RunViewState, detail: RunDetail): RunViewState;               // activities からペインを追加・更新（初出順）
  export function formatElapsed(ms: number): string;  // "12s" / "3m12s" / "1h05m"（status コマンドと同じ）
  export function stateLabelJa(state: AgentActivityState): string; // starting→起動中, thinking→考え中, running_tool→実行中, waiting_permission→権限待ち, idle→待機, finished→完了, failed→失敗
  ```
  - `active` は、そのエージェントの activity の state が `thinking` / `running_tool` / `waiting_permission` のとき true。
  - `title` は `"<agentLabel> · <role>"`。`stateLabel` は `"<stateLabelJa> <formatElapsed(now - since)>"`、stalled なら末尾に `  応答なし <分>分`。

- [ ] **Step 1〜4: RED → 実装 → GREEN**（ペインの追加順、既存テキストを消さない、上限での切り詰め、active / stalled の判定、日本語ラベル）
- [ ] **Step 5: commit** — `feat(web): Run画面の状態を組み立てる`

### Task 4: Run 画面（Vue）

**Files:**
- Create: `apps/web/src/components/RunList.vue`、`RunPipeline.vue`、`ActivityBar.vue`、`AgentPanes.vue`
- Modify: `apps/web/src/App.vue`（「コマンド」と「Run」の2つのタブ。既存のコマンド画面はそのまま「コマンド」タブへ）、`apps/web/src/style.css`

画面（設計書 §6.6 の配置）:

```text
┌ Runs ───────────┐┌ owner/repo#42  run  implementing ───────────────────────────────────────┐
│ ● #42 実装中     ││ plan ✓ ─ implement ● ─ verify ─ review ─ fix… ─ publish                  │
│ ○ #41 承認待ち   ││ 活動  Devin: 実行中 "pnpm test" 3m12s / Codex: 完了                      │
│ ✕ #39 失敗       ││ [エージェント別] [全体]                                                   │
│                  ││ ┌ Codex · planner ── 完了 ─┐┏ Devin · implementer ── 実行中 3m12s ┓    │
│                  ││ │ ── plan ──               │┃ ── implement ──                     ┃    │
│                  ││ │ ● Codex  計画を作成…     │┃ ● Edit  src/notify.ts               ┃    │
└──────────────────┘└───────────────────────────────────────────────────────────────────────────┘
```

- Run 一覧は 5 秒ごとに `GET /api/run-store/runs` を取り直す。選んだ Run の SSE を開き、別の Run を選んだら閉じる。
- ペインは等幅・自動スクロール。手でスクロールを上げたら自動スクロールを止め、一番下に戻したら再開する（「一時停止」ボタンでも切り替え）。`active` のペインは枠を強調、`stalled` は黄色の注意表示。
- 色だけに頼らず、状態は記号と文字（✓ / ● / ✕ / 応答なし）でも示す。
- [ ] **Step 1: 実装** — ロジックは Task 3 のモジュールを使い、コンポーネントは表示に徹する。
- [ ] **Step 2: 型と build** — `pnpm --filter @meguribi/web typecheck` と `pnpm --filter @meguribi/web build` が exit 0。
- [ ] **Step 3: 手動確認** — fake の Run（Task 2 のテストと同じ要領で、一時ディレクトリに state.json と events.jsonl を置き、`MEGURIBI_RUNS_ROOT` で指す）を用意してサーバーを起動し、一覧・パイプライン・ペイン・全体タブ・追記の反映を確認。確認手順と結果（スクリーンショットは不要、見えたものを文章で）を報告に書く。
- [ ] **Step 4: commit** — `feat(web): Run一覧・工程・活動・エージェント別ペインを表示`

### Task 5: `meguribi desk` とドキュメント

**Files:**
- Create: `apps/cli/src/commands/desk.ts`、Modify: `apps/cli/src/program.ts`
- Modify: `apps/web/README.md`、`docs/ja/cli-and-integrations.md`、`docs/en/cli-and-integrations.md`
- Test: `apps/cli/src/commands/desk.test.ts`

- [ ] `meguribi desk [--port <n>]`: リポジトリのルート（`apps/cli` から見た Meguribi のルート）で `pnpm --filter @meguribi/web dev` を、`MEGURIBI_WEB_PORT` を設定して引数配列で起動し、URL（`http://127.0.0.1:<port>`）を表示する。子プロセスの終了コードをそのまま返す。テストは起動関数を注入して、引数配列と環境変数を確認する。
- [ ] ドキュメント: Run 画面の使い方、`meguribi desk`、`MEGURIBI_RUNS_ROOT`、CLI から開始した Run も表示されること。日英同時。
- [ ] 全体検証 `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [ ] commit — `feat(cli): meguribi deskでCommand Deskを起動`
