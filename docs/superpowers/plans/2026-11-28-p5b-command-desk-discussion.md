# P5b Command Desk の議論ビュー・承認画面・発言挿入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Command Desk の Run 画面で、議論（`command: "discuss"` の Run）をスレッド表示し、議論中に人間が発言を挿入でき、結論を承認・却下（やり直し）できるようにする。

**Architecture:** 読み取りは P5a の `/api/run-store/...` を拡張し、議論の記録（`discussion/transcript.jsonl`）と結論（`discussion/conclusion.json`）を返す。書き込み（発言挿入・承認・却下）は、サーバーが **既存の Command Desk と同じく CLI を引数配列で起動する**（`meguribi say` / `approve` / `reject`）。サーバー自身は RunStore のファイルを書き換えない。画面の状態の組み立ては P5a と同じく純粋な TypeScript モジュールに置いてテストする。

**Tech Stack:** Vue 3、Vite、Node の `http`、SSE、TypeScript strict、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-27-multi-agent-orchestration-design.md`（§6.3、§6.6「画面」の議論ビュー・承認ビュー）

**前提:** P3（#83）の Task 5（`FileSystemDiscussionStore`）と Task 8（`meguribi say` / `approve` / `reject` コマンド）が main に入っていること。着手時にそれらの実際のシグネチャ・引数を確認し、この計画と食い違えば実際のコードを正とする。

## Global Constraints

- 新しい外部 npm 依存は追加しない。
- サーバーは `127.0.0.1` にだけ bind し、認証は持たない（従来どおり）。
- 書き込み系の操作は、サーバーが CLI（`pnpm exec tsx apps/cli/src/index.ts <command> ...`）を**引数配列で**起動して行う。シェル文字列の連結はしない。サーバーが RunStore・`inbox/`・`approval.json` を直接書くことはしない。
- 承認・却下・発言挿入の API は `POST` のみ。リクエスト本文は Valibot ではなく、既存の `command-specs.ts` と同じ手書きの検証（型・長さ・文字種）で受ける（`apps/web` に Valibot を足さない）。
- 発言は 4,000 文字まで、却下の理由は 2,000 文字まで。空や空白だけは拒否。
- 承認ボタンは、Run が `command: "discuss"` かつ `status: "awaiting_human"` で結論があるときだけ有効。押したら確認のダイアログ（ブラウザの `confirm` ではなく画面内の確認表示）を出してから送る。
- 画面に出すテキストは redaction 済み（サーバーで `redactDiagnosticText`）。
- 各タスクの commit は Conventional Commits。末尾に `Co-Authored-By` を付ける。

## Review Focus

- 承認の連打・2つのタブからの同時承認 → 2回目は CLI 側が `not_awaiting_approval` で失敗し、画面はそのエラーと次の操作を表示する（Task 2 にテスト）。
- 発言の本文にシェルのメタ文字（`; rm -rf ~`、`$(...)`）や改行 → 引数配列で渡るので実行されず、そのまま発言として記録される（Task 2 にテスト）。
- 議論が終わった Run（`awaiting_human` 以降）に発言を挿入しようとする → 送信欄を無効にし、API も 409 を返す（Task 2・4 にテスト）。
- 結論のない状態で承認 API を叩く → 409（Task 2 にテスト）。
- `turnIds` に記録にない ID が混じった結論 → リンクを作らず、ID の文字だけ表示する（Task 3 にテスト）。

---

### Task 1: 議論の記録と結論を読む API

**Files:**
- Modify: `apps/web/server/run-store-api.ts`
- Test: `apps/web/server/run-store-api.test.ts`（追記）

**Interfaces:**
- Consumes: `FileSystemDiscussionStore`（P3 Task 5）の `readTurns` / `readConclusion`、`approval.json`（`runStore.readArtifact`）
- Produces:
  ```ts
  export interface DiscussionDetail {
    turns: DiscussionTurn[];                      // redaction 済み
    conclusion: DiscussionConclusion | null;
    approval: ApprovalRecord | null;
    canInterject: boolean;                         // command === "discuss" かつ status が awaiting_human / completed / blocked / failed / cancelled / timed_out / interrupted 以外
    canDecide: boolean;                            // command === "discuss" かつ status === "awaiting_human" かつ conclusion あり
  }
  ```
  - `GET /api/run-store/runs/:runId/discussion` → `DiscussionDetail`。`command` が `discuss` でない Run は 404。
  - P5a の SSE（`/stream`）は、`discussion.turn` / `discussion.ended` イベントが来たら `event: discussion` / `data: DiscussionDetail` も送る。
- [ ] **Step 1〜4: RED → 実装 → GREEN**（記録の読み出し、`canInterject` / `canDecide` の各状態、discuss でない Run の 404、SSE で discussion が送られる）
- [ ] **Step 5: commit** — `feat(web): 議論の記録と結論を読むAPIを追加`

### Task 2: 発言挿入・承認・却下の API（CLI を起動）

**Files:**
- Create: `apps/web/server/discussion-actions.ts`
- Modify: `apps/web/server/index.ts`（ルーティング）
- Test: `apps/web/server/discussion-actions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CliRunner { run(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> }
  export function createDiscussionActions(options: { runStore: FileSystemRunStore; cli: CliRunner }): {
    handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
  };
  ```
  ルート（すべて `POST`、本文は JSON）:
  - `/api/run-store/runs/:runId/say` `{ "message": string }` → `meguribi say <runId> <message>`
  - `/api/run-store/runs/:runId/approve` `{ "comment"?: string }` → `meguribi approve <runId> [--comment <comment>]`
  - `/api/run-store/runs/:runId/reject` `{ "reason": string, "redo": boolean }` → `meguribi reject <runId> --reason <reason> [--redo]`
  - 事前検証: runId の形式（P5a と同じ）、Run の存在（404）、`say` は `canInterject`、`approve` / `reject` は `canDecide`（満たさなければ 409）、本文の型と長さ（400）。
  - CLI の終了コードが 0 → 200 `{ ok: true, stdout }`。0 以外 → 422 `{ ok: false, stderr }`（`stderr` は redaction 済み。CLI の nextAction をそのまま画面に出せる）。
  - `CliRunner` の既定実装は、既存の `index.ts` の `pnpmExecutable` / `pnpmArguments` と同じ方法で `pnpm exec tsx apps/cli/src/index.ts ...args` を `spawn` し、完了まで待つ。`reject` の `--redo` は議論を再実行するので完了まで時間がかかる。そのため `reject` だけは `spawn` 後すぐに 202 `{ ok: true, started: true }` を返し、進捗は SSE で追う。
- [ ] **Step 1: 失敗するテスト**（`CliRunner` は fake）— 各ルートが期待どおりの引数配列で CLI を呼ぶ。メッセージにシェルのメタ文字と改行を含めても1つの引数として渡る。409 / 400 / 404 / 422 の各分岐。2回目の承認で CLI が失敗したときに 422 と stderr が返る。
- [ ] **Step 2〜4: RED → 実装 → GREEN**
- [ ] **Step 5: commit** — `feat(web): 議論への発言挿入・承認・却下のAPIを追加`

### Task 3: 議論ビューの状態を組み立てる純粋モジュール

**Files:**
- Create: `apps/web/src/discussion-view.ts`
- Test: `apps/web/src/discussion-view.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ThreadNode { turn: DiscussionTurn; depth: number; children: ThreadNode[] }
  export function buildThread(turns: readonly DiscussionTurn[]): ThreadNode[];      // replyTo の最初の ID を親とし、親がなければルート。深さは最大 3 で打ち切る
  export interface ConclusionView {
    conclusion: string; endedByLabel: string;   // consensus → 全員合意、max_turns → 最大ターン到達、max_duration → 時間切れ、timeout → 応答なし
    issues: Array<{ issue: string; positions: Array<{ participant: string; stance: string; turnLinks: Array<{ id: string; exists: boolean }> }>; resolution: string }>;
    rejected: Array<{ option: string; reason: string; turnLinks: Array<{ id: string; exists: boolean }> }>;
    openQuestions: string[];
  }
  export function buildConclusionView(conclusion: DiscussionConclusion, turns: readonly DiscussionTurn[]): ConclusionView;
  ```
- [ ] **Step 1〜4: RED → 実装 → GREEN**（スレッドの親子、存在しない親、深さの打ち切り、ラベル、存在しない turnId の `exists: false`）
- [ ] **Step 5: commit** — `feat(web): 議論ビューの状態を組み立てる`

### Task 4: 議論ビューと承認画面（Vue）

**Files:**
- Create: `apps/web/src/components/DiscussionThread.vue`、`InterjectBox.vue`、`ConclusionPanel.vue`
- Modify: `apps/web/src/App.vue`（`command: "discuss"` の Run を選んだとき、P5a のペインの上に議論ビューを出す）、`apps/web/src/style.css`

画面（設計書 §6.6）:

```text
│ 議論  turn 14/20  終了: 全員合意                                         │
│ [Claude Code] 通知の量より、出すタイミングが問題では?             (t-3)  │
│   └[Codex] ログでは夜間の開封率が低い                             (t-4)  │
│       └[Devin] 実装コストはバッチ化が最小                         (t-5)  │
│ [あなた] 既存の設定画面は変えたくない                             (t-9)  │
│ ┌ 発言を挿入 ─────────────────────────┐ [送信]                          │
│──────────────────────────────────────────────────────────────────────────│
│ 結論: 夜間通知を朝にまとめて送る                    [承認] [却下・再議論] │
│  論点「タイミング」 Claude: まとめる / Codex: まとめる / Devin: 条件付き  │
│  不採用: 通知量の上限 — 重要通知も落ちる (t-6, t-8)                       │
```

- 話者ごとに色を変え、色だけでなく話者名でも区別する。`malformed` のターンには「形式不正」の目印。
- turnId のリンクを押すと、スレッドの該当ターンまでスクロールして強調する（`exists: false` はリンクにしない）。
- 承認・却下は画面内の確認表示を挟む。却下には理由の入力が必須で、「議論をやり直す」のチェックで `redo: true`。API が 422 を返したら、`stderr`（次の操作の案内を含む）をそのまま表示する。
- 発言挿入欄は `canInterject` が false なら無効にし、理由（「議論は終了しています」）を表示する。
- [ ] **Step 1: 実装**
- [ ] **Step 2: 型と build** — `pnpm --filter @meguribi/web typecheck` / `build` が exit 0
- [ ] **Step 3: 手動確認** — 一時ディレクトリに議論中の Run と結論つきの `awaiting_human` の Run を用意し（state.json、events.jsonl、discussion/transcript.jsonl、discussion/conclusion.json）、`MEGURIBI_RUNS_ROOT` で指してサーバーを起動する。`CliRunner` を差し替える環境変数は作らない。代わりに、手動確認では実際の `meguribi say` / `approve` を、一時ディレクトリの RunStore に対して実行して結果を確認する（実エージェントは起動しない）。スレッド表示、発言挿入（`inbox/` にファイルができる）、承認（`approval.json` ができ、ボタンが無効になる）、2回目の承認でエラー表示、を確認し、手順と結果を報告に書く。確認後にサーバーを停止する。
- [ ] **Step 4: commit** — `feat(web): 議論ビューと承認画面を表示`

### Task 5: ドキュメント

- [ ] `apps/web/README.md` と `docs/ja` / `docs/en` の cli-and-integrations に、議論ビュー・発言挿入・承認・却下の使い方と、書き込みはすべて CLI 経由であることを追記。日英同時。
- [ ] 全体検証 `pnpm lint && pnpm typecheck && pnpm test && pnpm build`、web の typecheck / lint / build
- [ ] commit — `docs: Command Deskの議論ビューと承認画面を反映`
