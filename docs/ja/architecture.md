# システムアーキテクチャ

## 1. 方針

Meguribi はローカルで実行する単一 CLI として実装します。

```text
利用者
  -> Meguribi CLI
      -> GitHub
      -> Git worktree
      -> Codex
      -> Devin
      -> 検証コマンド
```

MVP では、DB、常駐サーバー、ジョブキュー、Web UI、複数 Worker を持ちません。

## 2. システム境界

### Meguribi が所有するもの

- コマンド実行順序
- GitHub Issue / PR の取得と更新
- Codex / Devin 用コンテキストの構築
- 構造化成果物の保存
- Git worktree とブランチの作成・削除
- 検証コマンドの実行
- 保護パス・差分サイズ・再試行の制御
- Draft PR の作成

### Codex が所有するもの

- 課題候補、仮説、反対仮説の提案
- 要件案の構造化
- リポジトリ調査
- 技術計画
- コードレビュー
- テスト失敗の分析

### Devin が所有するもの

- 承認済みスコープ内のコード変更
- テスト追加
- 指定されたローカル検証の実行補助
- 実装結果と未解決事項の報告

### GitHub が所有するもの

- Issue とコメント
- ラベルとマイルストーン
- ブランチと Pull Request
- CI の正式結果
- マージ履歴

### 人間が所有するもの

- プロダクト優先順位
- 仮説・課題・要件の採用
- 高リスク変更の許可
- Pull Request のマージ
- リリース後評価

## 3. コンポーネント

```text
apps/cli
  |
  +-- core/workflows
  |     +-- discover
  |     +-- hypothesis
  |     +-- require
  |     +-- delivery
  |     `-- measure
  |
  +-- adapters
  |     +-- github
  |     +-- git
  |     +-- codex
  |     `-- devin
  |
  +-- services
  |     +-- context-builder
  |     +-- prompt-builder
  |     +-- verifier
  |     +-- policy-engine
  |     `-- run-store
  |
  `-- schemas
```

### CLI

- 引数とオプションを解析する。
- 対象リポジトリと Issue を解決する。
- ワークフローを起動する。
- 実行結果と次の人間操作を表示する。

### Workflow

コマンドごとの手続きを明示的に順番実行します。

汎用ワークフローエンジンは作らず、TypeScript の関数として記述します。

```ts
async function runDelivery(input: DeliveryInput): Promise<DeliveryResult> {
  const issue = await github.fetchIssue(input.target);
  const approval = await policy.assertReady(issue);
  const workspace = await git.createWorktree(issue);
  const plan = await codex.createPlan({ issue, workspace });
  const implementation = await devin.implement({ issue, plan, workspace });
  const verification = await verifier.run(workspace);
  const review = await codex.review({ issue, plan, verification, workspace });
  return github.createDraftPullRequest({ issue, workspace, review });
}
```

### GitHubAdapter

責務:

- リポジトリ情報取得
- Issue / コメント / ラベル取得
- 既存の Meguribi コメント検出
- コメント作成または更新
- Draft PR 作成
- PR / CI 状態取得

初期実装は `gh` CLI を利用します。呼び出し結果はアダプター内部で独自型へ変換し、コア層へ生の CLI JSON を漏らしません。

### GitAdapter

責務:

- リポジトリパスの確認
- dirty state の確認
- default branch の同期
- Issue 単位の worktree とブランチ作成
- status / diff / changed files の取得
- commit / push
- cleanup

### CodexAdapter

責務:

- Codex SDK の Thread を開始・再開する。
- 作業ディレクトリと権限を設定する。
- JSON Schema を指定して構造化出力を得る。
- Thread ID と利用量を保存する。

Codex TypeScript SDK は Codex CLI を子プロセスとして起動し、JSONL イベントを交換します。Meguribi は SDK 固有型をアダプター内に閉じ込めます。

### AgentAdapter

責務:

- 承認済み `ImplementationContext` を受け取り、指定 worktree で実装または修正を実行する。
- ACP lifecycle（initialize / session / prompt / shutdown）を adapter 内に閉じ込める。
- `ImplementationResult` へ正規化し、Git 権威の `changedFiles` と artifact 参照を返す。
- commit / push / PR / Issue 更新を行わない。

MVP の本番実装は `createDevinAcpAdapter`（Devin）と `createCursorAcpAdapter`（Cursor）です。CLI / workflow は `AgentAdapter` port だけに依存し、ACP SDK 型や CLI 固有の出力を知りません。implementer は `MEGURIBI_IMPLEMENTER`、`.meguribi.yml` の `implementer`、または `--implementer` で明示的に選択します。選択しない場合は fail-closed します。

#### エージェント実行安全境界

`PermissionRequest`、MCP 継承判定、実装 prompt、Git/worktree snapshot、shutdown は ACP adapter（Devin / Cursor 共通）の内側で正規化・検証します。ACP SDK の request / response 型や CLI 固有の出力を core workflow へ漏らしません。Issue、comment、fix instruction は untrusted として prompt builder が区切り、permission と Git の判定は prompt とは独立した PolicyEngine が行います。

`AcpShutdownController` は cancel、stdin close、grace period、terminate、force escalation を一度だけ実行し、`termination.json` へ結果を保存します。Git snapshot の HEAD、branch、remote、local config、protected path、symlink、diff limit の違反は publish gate の入力となり、Agent が申告した changed files より Git diff を優先します。

将来 API 連携へ変更しても、`AgentAdapter` のインターフェースは維持します。

### Verifier

AI の自己申告とは独立して、設定されたコマンドを実行します。

- install（必要時のみ）
- lint
- typecheck
- test
- build

各コマンドは `shell: false` で executable + argv として起動し、既定の per-command timeout（30分）を超えたら fail-closed で `timedOut` を記録します。Windows では PATH と `PATHEXT` 順で実行ファイルを解決し、拡張子なし名へ無条件に `.cmd` を付けません。開始時刻、終了時刻、終了コード、ログファイルを保存します。

### PolicyEngine

- 必要ラベルの確認
- リスク判定
- protected paths の確認
- changed files / diff lines 上限
- 禁止コマンド
- retry / timeout 上限
- merge や production deploy の禁止

### RunStore

ローカルファイルシステムへ、Issue 単位の実行情報を保存します。

DB は使いません。

## 4. 物理構成

```text
~/repos/
  `-- target-repository/          # 利用者の通常 checkout

~/.local/share/meguribi/
  +-- runs/
  |   `-- owner/repo/issue-123/run-YYYYMMDD-HHmmss/
  +-- worktrees/
  |   `-- owner/repo/issue-123/
  `-- cache/

Meguribi repository/
  +-- apps/cli/
  +-- packages/core/
  +-- packages/adapters/
  +-- packages/schemas/
  +-- prompts/
  `-- tests/
```

XDG Base Directory を利用し、OS ごとに保存先を解決します。対象リポジトリ内には一時ログを置きません。

## 5. 標準シーケンス

### 5.1 計画から Draft PR まで

```text
Human        CLI        GitHub       Git        Codex       Devin       CI
  |           |            |           |           |           |          |
  | run #123  |            |           |           |           |          |
  |---------->| fetch      |           |           |           |          |
  |           |----------->|           |           |           |          |
  |           | validate approval      |           |           |          |
  |           | create worktree ------>|           |           |          |
  |           | create plan ----------------------->|           |          |
  |           | save plan                          |           |          |
  |           | implement ------------------------------------>|          |
  |           | verify commands ----->|           |           |          |
  |           | review diff ---------------------->|           |          |
  |           | commit / push ------->|           |           |          |
  |           | create draft PR ----->|           |           |          |
  |<----------| summary               |           |           |          |
  |           |                        GitHub CI -------------------------->|
```

### 5.2 修正ループ

MVP では自動修正を 0 回または最大 1 回に制限します。

```text
検証失敗または review: changes_required
  -> Codex が修正指示を構造化
  -> PolicyEngine が対象範囲を確認
  -> Devin セッションを再開、または新規実行
  -> 再検証
  -> 上限到達時は停止して人間へ返す
```

## 6. 依存方向

```text
CLI -> Workflows -> Ports <- Adapters
                  -> Domain models
                  -> Schemas
```

- Workflow から SDK、`gh`、`git`、Devin コマンドを直接呼ばない。
- Adapter は Domain model へ変換して返す。
- Prompt builder は外部プロセスを呼ばない。
- PolicyEngine は副作用を持たず、判定結果だけを返す。

## 7. 推奨技術スタック

- Node.js 22 以上
- TypeScript strict mode
- pnpm workspace
- Commander: CLI
- execa: 子プロセス
- Valibot: 入力・設定・成果物検証
- JSON Schema: Codex 構造化出力（必要に応じて Valibot から生成）
- YAML parser: `.meguribi.yml`
- Vitest: unit / integration test
- ESLint または Biome: lint
- tsup または tsdown: CLI build

特定ライブラリは実装 Issue で最終確認しますが、依存を増やすより標準 API を優先します。

## 8. 状態モデル

汎用状態機械は作りませんが、Run は粗い `status` と細かい `currentStep` / `completedSteps` を `state.json` に持ちます。

粗い status 例:

```text
created -> planning -> planned -> implementing -> verifying
  -> reviewing -> publishing -> awaiting_human
```

細かい step 例（ACP / delivery）:

```text
preflight
awaiting_mcp_confirmation
implementing
implementation_completed
implementation_blocked
verifying
reviewing
fixing
publishing
```

異常系:

```text
blocked
failed
cancelled
timed_out
interrupted
```

状態更新は `state.json` を一時ファイルへ書いてから rename し、途中書き込みを避けます。`FileSystemRunStore` が atomic write と Issue 単位 lock を担当します。

## 9. 同時実行

MVP では次の制約を置きます。

- 同じ owner/repo#issue に対する同時 Run を禁止する。
- 同じ worktree を Codex と Devin が同時に変更しない。
- 一つの Run 内は原則直列実行する。
- リポジトリの fetch 操作だけ、別 Issue と共有可能にするのは将来対応とする。

## 10. 拡張ポイント

将来追加可能:

- Devin API adapter
- Claude Code adapter
- Slack 通知
- GitHub App / API adapter
- 計測サービス adapter
- 定期 discovery

ただし、追加時もローカル CLI と既存の Port を維持し、MVP のコアを肥大化させません。
