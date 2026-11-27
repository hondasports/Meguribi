# マルチエージェント・オーケストレーション設計

- 日付: 2026-11-27
- 状態: 承認済み（2026-11-27）
- 対象: Meguribi 本体（方針転換を含む）

## 1. 意図と背景

Claude Code、Codex、Devin（および既存の Cursor）を工程ごとに切り替えながら使い、さらに**エージェント同士で自由に議論させて、利用者が自分では気づけなかった視点を得る**。議論の結論はそのまま要件・仕様・コード・テストへ反映し、その流れ全体を画面で追えるようにする。

これは Meguribi の方針転換である。現行の次の前提を撤回する。

| 現行の前提 | 出典 | 転換後 |
|---|---|---|
| 汎用ワークフローエンジンを作らない | `AGENTS.md` §1、`docs/ja/architecture.md` §（Workflow は TypeScript 関数で逐次記述） | 宣言的ワークフローを実行するエンジンを持つ |
| Codex と実装エージェントを直接会話させない | `AGENTS.md` §6・§10、`docs/ja/artifacts-and-schemas.md` §1、`docs/ja/product-and-workflow.md` §6 | 議論工程ではエージェントの発言を他エージェントへそのまま渡す |
| 計画・レビューは Codex | `AGENTS.md` §10、`DeliveryDependencies.codex` | 役割ごとに任意のエージェントを割り当てる |
| MVP に Web UI を含めない | `README.md` Design constraints | ローカル Web UI（Command Desk）を可視化の正式な面とする |

## 2. ゴール・非ゴール・アンチゴール

### ゴール

- G1. Claude Code / Codex / Devin / Cursor を、役割（議論参加・計画・実装・レビュー・要約）ごとに設定で割り当てられる。
- G2. 複数エージェントが議論の場で、互いの発言を直接受け取りながら自由に議論できる。
- G3. 議論の結論を人間が1回承認すると、要件 → 仕様 → 計画 → コード + テスト → 検証 → レビュー → Draft PR まで自動で進む。
- G4. 工程の並びを YAML で定義でき、既存の delivery もその1つとして動く。
- G5. 実行中・過去の Run の流れ（工程、議論、エージェントの動き、承認待ち）をローカル Web UI で追える。CLI から開始した Run も表示できる。

### 非ゴール

- ホステッドサービス、マルチテナント、認証付きリモート公開。
- 常駐デーモン。Web UI は利用者が起動したときだけ動くローカルサーバーとする。
- DB、メッセージキュー。状態はこれまで通りファイル（RunStore）に置く。
- 任意のコードやシェルを実行するワークフロー工程。工程の種類は Meguribi が定義する閉じた集合とする。
- 工程の並列実行（v1）。逐次と上限付きループのみ。
- TUI（v1）。画面は Web のみ。

### アンチゴール（技術的に動いても失敗とみなすもの）

- A1. 議論の結論が人間を通らずにコードへ反映される。
- A2. 議論が終わらず、時間やコストが際限なく膨らむ。
- A3. 仕様・コード・テストがすべて同じ誤った結論から生成され、「テストは通るが方向が違う」ことを検出できない。
- A4. Issue や外部ファイルに埋め込まれた命令が、議論を通じて他エージェントへ伝播し、実装を乗っ取る。
- A5. 誰が何を言い、何が結論に効いたのかを後から追えない。
- A6. 既存の `run` / `resume` / `plan` / `review` などの振る舞いが壊れる。

## 3. 制約

- `AGENTS.md` §7 の技術選定（Node.js 24 LTS、TypeScript strict、pnpm、Valibot、Commander、execa 相当）を維持する。
- CI は Ubuntu と Windows。ネイティブ依存を増やさない。
- エージェント接続は ACP を標準とする（既存の `packages/adapters/src/acp` を再利用）。
- 実エージェント・実 GitHub を通常の自動テストから呼ばない。fake executable と fixture で検証する（`AGENTS.md` §13）。
- 安全ルールのうち §7 に挙げるものは転換後も維持する。

## 4. 検討したアプローチ

利用者は「全部お任せ」と判断を委ねたため、以下の採用はすべて設計者の判断である。

### 4.1 ワークフローエンジン

| 案 | 内容 | 長所 | 短所 | 判断 |
|---|---|---|---|---|
| **A. 閉じた工程種別 + YAML** | YAML で工程を並べ、Meguribi 定義の工程種別だけを逐次実行 | 安全ルールを定義の静的検査で強制できる。可視化しやすい | 工程種別の追加にはコード変更が要る | **採用** |
| B. TypeScript でワークフローを記述 | 小さな step runner ライブラリ + コード定義 | 柔軟、型が効く | 安全ルールを機械的に検査しにくい。「定義を自由に組む」体験にならない | 不採用 |
| C. 既存エンジン（Temporal、LangGraph.js など） | 外部エンジンに乗る | 機能が豊富 | 常駐サービスや重い依存。local-first と衝突 | 不採用 |

### 4.2 エージェント同士の会話

| 案 | 内容 | 長所 | 短所 | 判断 |
|---|---|---|---|---|
| **A. 議論ルーム（Meguribi が中継）** | 各エージェントの発言を加工せず、他の参加者の ACP セッションへそのまま渡す | 実質的に直接会話。上限・記録・可視化・介入を確実にかけられる | 発言順を Meguribi が決める | **採用** |
| B. MCP ツールで相手を直接呼ぶ | 各エージェントに `ask_<agent>` ツールを与える | エージェント主導で本当に直接 | 呼び出しの入れ子・上限・記録が難しい。A2/A5 に弱い | 不採用 |
| C. 共有ファイルに書き込み合う | 共通の Markdown を読み書き | 単純 | 順序と競合の制御が難しく、可視化も粗い | 不採用 |

### 4.3 可視化

| 案 | 判断 |
|---|---|
| **既存 Command Desk（Vue + SSE）を拡張** | **採用**。既に localhost 専用サーバーと SSE がある |
| TUI（Ink など） | 見送り。イベントログ（§6.6）が共通なので後から追加可能 |

## 5. 全体像

```text
              ┌──────────── Workflow Engine（逐次・上限付きループ）────────────┐
 Issue ──▶ discuss ──▶ approve ──▶ specify ──▶ plan ──▶ implement ──▶ verify ──▶ review ─┬▶ publish ──▶ Draft PR ──▶ 人間がマージ
              │  ▲         │(人間)                                          ▲          │
              │  │         │                                                └─ fix ◀───┘ (上限 maxFixAttempts)
         議論ルーム
     Claude Code / Codex / Devin
              │
              ▼
     events.jsonl（全工程・全発言）──▶ Command Desk（SSE）
```

## 6. 設計

### 6.1 エージェント層：役割と割り当て

#### プロファイル

接続できるエージェントを `AgentProfile` として定義する。

```yaml
# .meguribi.yml（例）
agents:
  claude:
    kind: claude-code     # claude-code | codex | devin | cursor
    transport: acp
  codex:
    kind: codex
    transport: acp        # 既存の Codex SDK を使う場合は sdk
  devin:
    kind: devin
    transport: acp

roles:
  discussants: [claude, codex, devin]
  summarizer: claude
  planner: codex
  implementer: devin
  reviewer: claude
```

- `kind` ごとの起動方法（実行ファイル、引数、診断）は既存の `devin` / `cursor` アダプターと同じ形で `packages/adapters/src/<kind>` に置く。
- Claude Code と Codex は、それぞれの ACP アダプター（公開パッケージ名・起動方法は実装時に確認する）経由で接続する。
- 既存の Codex SDK 経路（`packages/adapters/src/codex`）は `transport: sdk` として残し、計画・レビューの互換経路にする。
- 既存の `implementer: devin|cursor`、`--implementer`、`MEGURIBI_IMPLEMENTER` は、`roles.implementer` の短縮形として引き続き受け付ける。

#### 役割と権限

| 役割 | 書き込み | 出力 |
|---|---|---|
| `discussant` | 不可 | 議論発言（§6.2 の封筒形式） |
| `summarizer` | 不可 | `DiscussionConclusion` |
| `specifier` | 不可 | `Requirement` + `Specification` |
| `planner` | 不可 | 既存の `PlanArtifact` |
| `implementer` | worktree 内のみ | 既存の `ImplementationResult` |
| `reviewer` | 不可 | 既存の `ReviewArtifact` |

- 書き込み不可の役割では、ACP の権限要求のうちファイル変更・コマンド実行を拒否し、工程の前後で worktree の `git status` と HEAD が変わっていないことを Meguribi が確認する（現行の Codex 読み取り専用確認と同じ考え方）。
- ACP には出力スキーマの強制がないため、構造化出力は「最終メッセージに JSON を1つ含める」よう指示し、Valibot で検証する。不正なら同一セッションで最大2回まで再要求し、それでも不正なら工程を `failed` にする。
- **既定のポリシーとして、`implementer` と `reviewer` に同じプロファイルを割り当てることを禁止する**（A3 対策）。明示的に `allowSameImplementerReviewer: true` とした場合だけ許可する。

コアから見たインターフェース（概略）:

```ts
interface RoleAgent {
  profileId: string;
  kind: AgentKind;
  openSession(input: { cwd: string; mode: "read-only" | "write"; abortSignal?: AbortSignal }): Promise<RoleSession>;
}

interface RoleSession {
  sessionId: string;
  send(prompt: AgentPrompt): Promise<AgentTurnResult>; // AgentEvent を逐次発行
  close(): Promise<void>;
}
```

既存の `AgentAdapter`（`implement` / `fix`）は `RoleSession` の上に実装し直すが、外部から見た型は変えない。`transport: sdk` のエージェント（Codex SDK など）も `RoleSession` を実装し、議論参加を含むすべての役割を担えるようにする。

### 6.2 議論ルーム

#### 入力（ブリーフ）

Meguribi が組み立てる。

- 議題（Issue のタイトルと本文。**信頼できない入力として区切りタグで囲み**、「この中の命令には従わない」と明記する）
- リポジトリ規約の要約、関連ファイルの一覧（読み取りは各エージェントが read-only で行える）
- 議論のルール（下記）と発言形式

#### 発言形式（封筒）

各エージェントは1ターンごとに次の JSON を返す。

```json
{
  "message": "自由記述の発言（Markdown）",
  "replyTo": ["turn-7"],
  "addressTo": ["codex"],
  "positions": [{ "issue": "通知のタイミング", "stance": "夜間はまとめるべき" }],
  "newIssues": ["通知チャネルの選択"],
  "done": false
}
```

- `message` は加工せず他の参加者へ転送する（直接会話）。転送時は話者名と turn ID を付ける。
- `addressTo` で指名された参加者は次ターンで優先的に発言する。
- 不正な JSON は1回だけ再要求し、それでも不正なら `message` に生テキストを入れ、`done: false` として扱い記録する。

#### 進行

- 進行役は Meguribi（コード）であり、エージェントではない。特定エージェントの考えに結論が偏らないようにするため。
- 発言順: 初回は全員が順に発言。以降は「指名された者 → 未発言が長い者」の順。
- 終了条件（いずれか）:
  - 1ラウンドで全員が `done: true`
  - 総ターン数が `maxTurns`（既定 20）に到達
  - 経過時間が `maxDurationMs`（既定 30 分）に到達
  - 1ターンのタイムアウト（既定 5 分）が同じ参加者で2回連続
- 人間は議論中にいつでも発言を挿入できる（話者 `human`）。挿入しなくても議論は進む。
- 終了後、`summarizer` が全記録から `DiscussionConclusion` を作る。

#### 成果物

```ts
interface DiscussionConclusion {
  topic: string;
  conclusion: string;                         // 採用する方向の要約
  issues: Array<{
    issue: string;
    positions: Array<{ participant: string; stance: string; turnIds: string[] }>;
    resolution: string;
  }>;
  rejectedOptions: Array<{ option: string; reason: string; turnIds: string[] }>;
  openQuestions: string[];
  acceptanceCriteriaSeeds: string[];          // 要件化の種
  endedBy: "consensus" | "max_turns" | "max_duration" | "timeout";
  transcriptHash: string;
}
```

`turnIds` によって、結論のどの部分が誰のどの発言から来たかを追える（A5）。

議論の全記録は `discussion/transcript.jsonl`、結論は `discussion/conclusion.json` として RunStore の Run ディレクトリに保存する。保存前に secret redaction を行う（既存の `redact`）。

### 6.3 結論の承認（人間ゲート）

- `approve` 工程は Run を `awaiting_human` にして停止する。
- 承認面: Command Desk の承認画面、または CLI `meguribi approve <runId>` / `meguribi reject <runId> --reason ...`。
- 承認記録 `approval.json`: 承認者（ローカルの git user）、日時、**承認した `conclusion.json` のハッシュ**、任意コメント。
- 後続工程は開始時にハッシュを照合し、結論が承認後に変わっていたら停止する。
- 却下時の選択肢: Run を終了する／コメントを議題に追加して議論をやり直す（やり直しは Run あたり最大2回）。
- 非対話モード（`--non-interactive`）では承認工程で必ず停止する。自動承認のオプションは設けない（A1）。

### 6.4 仕様化（specify 工程）

承認済みの結論から、`specifier` 役が次を作る。

- `Requirement`: 既存の `require` コマンドの成果物スキーマ（`packages/schemas/src/require.ts`）を再利用する。
- `Specification`: 受け入れ条件（Given / When / Then）、対象範囲、範囲外、想定テスト一覧。

受け入れ条件は `acceptanceCriteriaSeeds` と1対1で対応付け、対応のないものは `openQuestions` として残す。仕様は PR 本文と RunStore に保存し、対象リポジトリにはファイルとして commit しない（対象リポジトリを汚さないための判断）。

A3 対策:

- 後続の `plan` には、仕様の受け入れ条件を `completionCriteria` として渡す。
- `review` は既存の `ReviewRequirementCoverage` で、受け入れ条件ごとの充足を判定する。
- `reviewer` は `implementer` とは別のエージェントが担当する（§6.1）。

### 6.5 ワークフローエンジン

#### 定義

```yaml
# 組み込み: workflows/discuss-to-pr.yml
name: discuss-to-pr
steps:
  - id: discuss
    kind: discuss
  - id: approve
    kind: approve
    of: discuss
  - id: specify
    kind: specify
  - id: plan
    kind: plan
  - id: implement
    kind: implement
  - id: verify
    kind: verify
  - id: review
    kind: review
    onChangesRequired: { goto: fix, max: 3 }
  - id: fix
    kind: fix
    then: verify
  - id: publish
    kind: publish
```

- 工程種別（閉じた集合）: `discuss`, `approve`, `specify`, `plan`, `implement`, `fix`, `verify`, `review`, `publish`。
- 制御: 逐次と、`goto` + `max` による上限付きループのみ。条件式・変数・任意コマンドはない。
  - `onChangesRequired: { goto, max }`: `review` の結果が `changes_required` のとき指定工程へ戻る。`max` 回を超えたら Run を `blocked` にする。
  - `then`: その工程の完了後に、定義順ではなく指定工程へ進む。
  - `of`: `approve` が承認対象とする工程（成果物）を指す。
- 定義の置き場所: 組み込み定義は Meguribi に同梱する。利用者定義は対象リポジトリの `.meguribi/workflows/*.yml`。
- 既存の `runDelivery` を組み込みワークフロー `delivery`（`plan → implement → verify → review ⇄ fix → publish`）として移植する。既存の `run` / `resume` コマンドは内部でこれを実行し、**外から見た振る舞い・成果物・終了コードを変えない**。既存の fixture テスト（`packages/adapters/src/workflow/*.test.ts`）をそのまま通すことを移植完了の条件とする。

#### 定義の静的検査（PolicyEngine）

実行前に次を検査し、違反があれば実行しない。

- `implement` / `fix` / `publish` より前に `discuss` があるなら、その間に `approve`（`of: discuss`）がある。
- `publish` の前に `verify` と `review` がある。
- `implement` の後に `verify` がある。
- すべての `goto` に `max` がある。
- 工程 ID が一意で、参照先が存在する。

#### Run の開始

- 対象は現行と同じく Issue（`<target>`）。`--request` で議題に利用者の要望を追加できる（既存の `plan --request` と同じ上限・検証）。
- エンジンは最初の工程の前に、現行 delivery の `context` / `preflight` / `worktree` 相当の準備（Issue 取得、ラベルによる readiness 判定、リポジトリ identity 確認、worktree 作成）を共通で行う。ワークフロー定義にはこれらを書かない。
- `discuss` を含む工程はこの worktree を cwd として read-only で実行する。

#### 承認待ちでのプロセスの扱い

- 常駐プロセスを持たないため、`approve` 工程に到達したら状態を保存してプロセスは終了する（終了コードは現行の `awaiting_human` と同じ扱い）。
- `meguribi approve <runId>` は承認を記録したうえで、そのプロセスで後続工程の実行を続ける。Command Desk の承認ボタンは、既存の Command Desk と同じく CLI（`approve`）を引数配列で起動する。
- `inbox/` は実行中プロセスへの議論中の発言挿入にだけ使う。エンジンはターンの合間に `inbox/` を確認する。

#### 実行と再開

- 各工程の状態を RunStore の `steps/<stepId>.json` に保存する（`pending | running | completed | failed | awaiting_human | skipped`）。
- `resume` は最後に完了した工程の次から再開する。議論は途中のターンから再開せず、`discuss` 工程を最初からやり直す（ACP セッションの途中再開が保証されないため）。
- 既存の `RunState.status` / `currentStep` は、互換のため工程状態から導出して更新し続ける。

### 6.6 イベントログと可視化

#### イベントログ

- エンジンは全イベントを Run ディレクトリの `events.jsonl` に追記する。

```ts
type WorkflowEvent =
  | { type: "workflow.started"; runId; workflow; at }
  | { type: "step.started" | "step.completed" | "step.failed"; runId; stepId; kind; at; detail? }
  | { type: "discussion.turn"; runId; turnId; participant; message; replyTo; addressTo; at }
  | { type: "discussion.human"; runId; turnId; message; at }
  | { type: "approval.required" | "approval.granted" | "approval.rejected"; runId; stepId; at }
  | { type: "agent.event"; runId; stepId; profileId; event: AgentEvent }   // 既存 AgentEvent を包む
  | { type: "workflow.finished"; runId; status; at };
```

- Command Desk のサーバーは RunStore を読み、`events.jsonl` を tail して SSE で配信する。これにより、CLI から開始した Run も画面で追える。
- 議論中の人間の発言挿入は、Command Desk から Run ディレクトリの `inbox/` へ JSON ファイルを書き、エンジンがそれを取り込む（プロセス間の受け渡しをファイルで行い、常駐の仕組みを作らない）。承認は §6.5 のとおり CLI 経由で行う。

#### 画面

```text
┌ Runs ───────────┐┌ Run 2026-11-27-01  discuss-to-pr  Issue #42 ────────────────────────────┐
│ ● #42 承認待ち   ││ discuss ✓ ─ approve ⏸ ─ specify ─ plan ─ implement ─ verify ─ review ─ PR │
│ ○ #41 PR作成済み ││──────────────────────────────────────────────────────────────────────────│
│ ✕ #39 失敗       ││ 議論  turn 14/20  終了: 全員合意                                         │
│                  ││ [Claude] 通知の量より、出すタイミングが問題では?             (t-3)      │
│                  ││   └[Codex] ログでは夜間の開封率が低い                         (t-4)      │
│                  ││       └[Devin] 実装コストはバッチ化が最小                     (t-5)      │
│                  ││ [あなた] 既存の設定画面は変えたくない                        (t-9)      │
│                  ││ ┌ 発言を挿入 ──────────────────────────────┐                             │
│                  ││──────────────────────────────────────────────────────────────────────────│
│                  ││ 結論: 夜間通知を朝にまとめて送る                    [承認] [却下・再議論] │
│                  ││  論点「タイミング」 Claude: まとめる / Codex: まとめる / Devin: 条件付き  │
│                  ││  不採用: 通知量の上限 — 重要通知も落ちる (t-6, t-8)                       │
└──────────────────┘└──────────────────────────────────────────────────────────────────────────┘
```

- Run 一覧、工程のパイプライン表示（状態を色と記号で表す）。
- 議論ビュー: `replyTo` によるスレッド表示、話者ごとの色、ターン数、発言挿入欄。
- 承認ビュー: 結論、論点ごとの立場、不採用案、対応 turn へのリンク、承認・却下ボタン。
- 工程詳細: エージェントのツール呼び出し、変更ファイル、検証コマンドの結果とログ。

Command Desk は従来どおり localhost にだけ bind し、認証は持たない。

### 6.7 CLI

| コマンド | 内容 |
|---|---|
| `meguribi workflow list` | 利用可能なワークフローを表示 |
| `meguribi workflow validate [file]` | 定義の静的検査 |
| `meguribi workflow run <name> <target>` | ワークフローを実行 |
| `meguribi discuss <target>` | `discuss` → `approve` だけを実行（結論を得るまで） |
| `meguribi approve <runId>` / `meguribi reject <runId>` | 承認・却下 |
| `meguribi desk` | Command Desk を起動 |
| 既存コマンド | 振る舞いを変えない。`run` は内部で `delivery` ワークフローを使う |

## 7. 転換後も維持する安全ルール

- commit / push / PR 作成・Issue 更新は Meguribi だけが行う。エージェントには担当させない。
- 検証は Meguribi 自身がコマンドを実行し、終了コードとログで判断する。
- default branch への push、force push、自動マージ、リポジトリ設定変更は禁止。
- マージ前の人間確認、議論結論の人間承認（§6.3）。
- 保護パス、diff 上限、変更ファイル数上限、worktree 外変更の検出。
- 外部入力（Issue、コメント、ファイル）は信頼できない入力として区切って渡す。議論工程は全員 read-only。
- ログ・成果物の保存前の secret redaction。
- 時間・ターン・再試行・やり直しの上限。

## 8. 作る順番

各フェーズは1つ以上の GitHub Issue にし、`AGENTS.md` の標準実装フロー（Readiness Gate → worktree → TDD → 検証 → レビュー → Draft PR）で進める。

| フェーズ | 内容 | 完了の目安 |
|---|---|---|
| P0 方針転換の明文化 | `AGENTS.md`、`README.md`、`docs/ja` と `docs/en`（product-and-workflow、architecture、artifacts-and-schemas、security-and-operations、implementation-roadmap）、関連スキルを本設計に合わせて改訂 | 日英が一致し、旧前提が残っていない |
| P1 エージェント層 | `AgentProfile` / `RoleAgent` / `RoleSession`、Claude Code と Codex の ACP 接続、役割割り当て設定、既存 implementer 設定の互換 | 各 kind を fake executable で診断・1ターン実行できる。既存テストが通る |
| P2 ワークフローエンジン | 定義のスキーマと静的検査、逐次実行、工程状態、再開、`events.jsonl`、`delivery` の移植 | 既存の delivery fixture テストが無変更で通る |
| P3 議論と承認 | 議論ルーム、封筒、進行、終了条件、要約、承認ゲート、`discuss` / `approve` / `reject` コマンド | fake エージェント3体で合意終了・上限終了・タイムアウト・不正 JSON・却下再議論の fixture テストが通る |
| P4 仕様化と通し | `specify` 工程、`discuss-to-pr` 組み込みワークフロー、implementer ≠ reviewer ポリシー | fake エージェントで Issue → Draft PR 相当まで通る fixture テスト |
| P5 可視化 | Command Desk の Run 一覧・パイプライン・議論・承認・工程詳細、`events.jsonl` の SSE 配信、`inbox/` 経由の介入と承認、`meguribi desk` | CLI 起動の Run が画面に出る。画面から承認して後続が進む |

P5 の一部（Run 一覧とパイプライン表示）は P2 の完了後に前倒ししてもよい。

## 9. テスト方針

- 工程定義の parser・静的検査、封筒の検証、終了条件の判定、承認ハッシュ照合: Unit test。
- 各エージェント kind の ACP 接続: fake executable による Integration test（既存の cursor / devin のテストと同じ形）。
- 議論ルーム: 台本どおりに応答する fake エージェントによる fixture test。
- ワークフロー: 一時 Git リポジトリと fake アダプターによる正常系・異常系（工程失敗、承認却下、resume、タイムアウト、signal）。
- Command Desk: サーバーの `events.jsonl` tail と SSE、`inbox/` 書き込みの Unit / Integration test。

## 10. 実装者に任せる事項

- ディレクトリ・ファイルの細かな配置、型名の最終決定。
- 議論の発言順アルゴリズムの細部（§6.2 の方針の範囲内）。
- ブリーフと各役割のプロンプト文面（バージョンとハッシュは既存の `promptVersion` / `promptHash` と同様に記録する）。
- 既定の上限値の微調整（変更時は理由を PR に記載）。
- 画面の配色・レイアウトの細部。

## 11. リスクと未確認事項

- Claude Code・Codex の ACP アダプターの提供状況、起動方法、権限要求の粒度。P1 の最初に確認し、使えない場合は該当 kind を `transport: sdk`（Claude Agent SDK / Codex SDK）で実装する。
- エージェントが封筒 JSON を安定して返せるか。P3 の初期に実エージェントで手動スパイクを行い、再要求の上限を調整する。
- 3体 × 最大20ターンの利用コスト。上限は設定で下げられるようにし、Run ごとに使用ターン数と所要時間を記録して画面に出す。
- `runDelivery` の移植で振る舞いが変わるリスク。P2 では新機能を足さず、移植のみを行う。
