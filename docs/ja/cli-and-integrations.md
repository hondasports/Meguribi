# CLI と外部連携仕様

## 1. CLI の基本形式

```text
meguribi <command> <target> [options]
```

`target` は次の形式を受け付けます。

```text
owner/repo
owner/repo#123
https://github.com/owner/repo
https://github.com/owner/repo/issues/123
https://github.com/owner/repo/pull/456
```

対象リポジトリを省略できるのは、現在ディレクトリが Git リポジトリであり、remote から一意に解決できる場合だけです。

## 2. コマンド一覧

### `meguribi init`

対象リポジトリを Meguribi で扱えるか診断し、設定ファイルの雛形を生成します。

```bash
meguribi init ./path/to/repository
```

確認内容:

- Git リポジトリか
- remote と GitHub リポジトリが一致するか
- `git`、`gh`、Codex、Devin の利用可否
- GitHub / Codex / Devin の認証状態
- default branch
- package manager
- 検証コマンド候補
- `AGENTS.md`
- 必要ラベルの存在

既定では GitHub へ書き込みません。`--apply-labels` を指定した場合だけ不足ラベルを作成します。

### `meguribi discover`

既存 Issue、指定資料、任意の利用データから課題候補を抽出します。

```bash
meguribi discover owner/repo --since 30d --limit 5
```

既定では候補をローカルに保存し、Issue を自動作成しません。

### `meguribi hypothesis`

課題候補または Issue から仮説を構造化します。

```bash
meguribi hypothesis owner/repo#123
```

### `meguribi promote`

検証済み Hypothesis Issue から Problem Issue の草案を生成します。

```bash
meguribi promote owner/repo#123
```

既定動作は草案表示です。`--create-issue` で人間確認後に新規 Issue を作成します。

### `meguribi explore`

Problem Issue に対する複数の解決方針を比較します。

```bash
meguribi explore owner/repo#124
```

比較軸:

- ユーザー価値
- 仮説検証力
- 実装コスト
- 運用コスト
- リスク
- 可逆性
- プロダクト方針との整合性

### `meguribi require`

採用した解決方針を Requirement / Feature Issue の草案へ変換します。

```bash
meguribi require owner/repo#124 --solution 2
```

### `meguribi plan`

Codex が対象リポジトリを読み取り、技術計画を作成します。`plan` はコードを変更しません。

```bash
meguribi plan owner/repo#125
```

### `meguribi run`

承認済み Issue を実装し、検証し、Codex レビューを行い、Draft PR を作成します。

```bash
meguribi run owner/repo#125
```

主要オプション:

- `--repo-path <path>`
- `--base <branch>`
- `--no-commit`
- `--no-push`
- `--no-pr`
- `--wait-checks`
- `--allow-risk <level>`
- `--max-fix-attempts <number>`
- `--dry-run`

### `meguribi review`

既存 PR または Issue に紐づくブランチ差分を Codex でレビューします。

```bash
meguribi review owner/repo#125
meguribi review https://github.com/owner/repo/pull/456
```

### `meguribi resume`

中断した Run を最後に完了したステップから再開します。

```bash
meguribi resume owner/repo#125
```

再開前に branch、worktree、HEAD、Issue、PR が保存状態と一致するか確認し、差異がある場合は停止します。

### `meguribi measure`

Requirement / Feature Issue と PR から Measurement Issue の草案を作ります。

```bash
meguribi measure owner/repo#125 --period 14d
```

### `meguribi cleanup`

終了した Run の worktree と一時情報を整理します。未マージ・未保存の変更は削除しません。

```bash
meguribi cleanup owner/repo#125
```

## 3. 共通オプション

```text
--config <path>
--json
--verbose
--quiet
--non-interactive
--dry-run
--run-id <id>
```

`--json` は stdout に最終 JSON だけを出し、進行ログは stderr へ出します。

## 4. 終了コード

| Code | 意味 |
|---:|---|
| 0 | 成功 |
| 1 | 一般的な実行失敗 |
| 2 | 引数・設定エラー |
| 3 | 認証・権限エラー |
| 4 | 承認不足・ポリシーブロック |
| 5 | Git / worktree 競合 |
| 6 | Agent 実行失敗 |
| 7 | 検証失敗 |
| 8 | GitHub 更新失敗 |
| 9 | 中断・キャンセル |

## 5. 設定ファイル

対象リポジトリのルートに `.meguribi.yml` を置きます。

```yaml
version: 1

repository:
  baseBranch: main

commands:
  install:
    - pnpm install --frozen-lockfile
  verify:
    - name: lint
      run: pnpm lint
    - name: typecheck
      run: pnpm typecheck
    - name: test
      run: pnpm test
    - name: build
      run: pnpm build

paths:
  protected:
    - .env
    - .env.*
    - .github/workflows/**
    - '**/*secret*'

limits:
  timeoutMinutes: 60
  maxChangedFiles: 20
  maxDiffLines: 1500
  maxFixAttempts: 1

approvals:
  productLabel: product:approved
  readyLabel: agent:ready
  highRiskInteractiveOnly: true

github:
  createDraftPullRequest: true
  waitForChecks: false

codex:
  sandboxMode: read-only
  networkAccess: false

devin:
  executable: devin
  transport: acp
  gracefulShutdownMs: 2000
  terminateTimeoutMs: 3000
  forceKillTimeoutMs: 1000
  startupTimeoutMs: 10000
  turnTimeoutMinutes: 45
  inheritedMcpPolicy: warn
```

`transport: acp` が MVP の標準です。秘密情報やトークンは設定ファイルへ記述しません。

`inheritedMcpPolicy` は、Devin CLI が利用者の保存済み MCP 設定を継承する可能性をどう扱うかを表します。

- `warn`: 対話実行では警告を表示し、利用者へ確認する
- `deny`: MCP 接続を検知した場合に停止する
- `allow`: 利用者の Devin 設定を明示的に受け入れる

MVP の既定値は `warn` とします。非対話実行では `warn` を許可せず、`allow` または `deny` を明示しない限り安全側へ停止します。MCP を完全に隔離できると表現してはいけません。

`transport` は MVP では `acp` だけを受け付けます。`executable` は単一の実行ファイル名またはパスです。コマンド引数（`devin acp` など）、`--token=SECRET` のような flag や環境変数代入、`http://...` や `file://...` のような URL scheme は受け付けません。空白を含まないパスは文字列、空白を含むパスは必ず1要素の配列で指定します（例：`["C:\\Program Files\\Devin\\devin.exe"]`、`["/my dir/bin/devin"]`）。配列が2要素以上になることはありません。これにより command-line argument を executable path と曖昧にできません。環境変数 `MEGURIBI_DEVIN_EXECUTABLE` では空白を含むパスを `'["C:\\\\Program Files\\\\Devin\\\\devin.exe"]'` のような JSON 1要素配列で指定してください。文字列のままでは空白を含む path は受け付けません。すべての timeout は 1 以上の整数で、ms 単位の timeout は setTimeout の 32-bit 上限未満（約24.8日未満）、`turnTimeoutMinutes` はその分換算で同じ上限未満です。無効化または無限待機にはできません。未知の設定キーと未知の policy は validation error とします。shell command template、credential path、token、cookie は設定項目に含めません。

## 6. 設定の優先順位

低い順:

1. Meguribi 内蔵値
2. ユーザー設定。`XDG_CONFIG_HOME` が設定されていれば `$XDG_CONFIG_HOME/meguribi/config.yml`、Windows では `%APPDATA%\meguribi\config.yml`（または `%LOCALAPPDATA%`）、それ以外では `~/.config/meguribi/config.yml`
3. リポジトリ設定 `.meguribi.yml`
4. 環境変数
5. CLI オプション

環境変数では、`MEGURIBI_DEVIN_EXECUTABLE`、`MEGURIBI_DEVIN_TRANSPORT`、`MEGURIBI_DEVIN_INHERITED_MCP_POLICY`、および各 timeout に対応する `MEGURIBI_DEVIN_*` だけを受け付けます。任意の環境変数、token、cookie は設定へ取り込みません。

各 Run の `state.json` には、秘密情報を除いた解決済み設定を保存します。

## 7. Codex 連携

### 7.1 接続方式

初期実装は `@openai/codex-sdk` を使用します。

```ts
export interface CodexAdapter {
  createHypothesis(input: HypothesisInput): Promise<HypothesisArtifact>;
  createRequirements(input: RequirementInput): Promise<RequirementArtifact>;
  createPlan(input: PlanningInput): Promise<PlanArtifact>;
  review(input: ReviewInput): Promise<ReviewArtifact>;
  analyzeFailure(input: FailureInput): Promise<FixInstructionArtifact>;
}
```

### 7.2 Thread と権限

- ロールごとに Thread を分ける
- 同じタスクの修正だけ既存 Thread を再開する
- Thread ID を Run に保存する
- discovery / hypothesis / require / plan / review は読み取り専用
- network access は既定で無効
- コード変更を Codex に許可しないのが MVP の標準

### 7.3 構造化出力

Codex にはコマンドごとの JSON Schema を指定します。自然文の最終回答を解析して制御フローを決めません。

## 8. Devin 連携

### 8.1 採用する接続方式

MVP は `DevinAcpAdapter` を採用し、Meguribi が `devin acp` を Issue 専用 worktree を `cwd` として子プロセス起動します。人間が事前に Devin CLI を起動しておく必要はありません。

```text
Meguribi
  -> DevinAcpAdapter
      -> ACP client
          -> devin acp subprocess
```

```ts
export interface DevinAdapter {
  implement(input: ImplementationInput): Promise<ImplementationResult>;
  fix(input: FixInput): Promise<ImplementationResult>;
}
```

ACP 固有の request / event / error 型は adapter 内に閉じ込め、コア層では正規化した `AgentEvent` とドメイン型だけを扱います。

### 8.2 ACP セッション

最低限、次の ACP ライフサイクルを扱います。

```text
process spawn
  -> initialize
  -> session/new
  -> session/prompt
  -> session/update stream
  -> turn completion
  -> controlled shutdown
```

保存対象:

- Devin CLI バージョン
- session ID
- raw ACP event log
- 正規化 event log
- stderr 診断ログ
- stop reason
- duration
- process exit code / signal
- Git が確認した changed files

Devin が報告した changed files は参考情報とし、正本は `GitAdapter` が取得した差分です。

### 8.3 終了シーケンス

Issue #3 の PoC では、prompt 完了後も `devin acp` が待機状態で残りました。これは通信失敗ではなく、stdio ACP server のプロセス寿命として扱います。

通常完了時:

1. turn 完了と `stopReason` を保存する
2. stdin を閉じる
3. 短い grace period を待つ
4. 終了しなければ `SIGTERM` を送る
5. さらに終了しなければ強制終了する
6. 子プロセス・子孫プロセスの残留がないことを確認する

キャンセル・timeout 時:

1. 可能なら `session/cancel` を送る
2. stdin を閉じる
3. grace period 後に `SIGTERM`
4. 必要時に強制終了

POSIX では `SIGTERM` / `SIGKILL` を使用します。Windows では同等のプロセスツリー終了を `ProcessTerminator` の背後へ抽象化します。

### 8.4 MCP 設定継承

Issue #3 と #6 の PoC では、通常の利用者環境で `devin acp` を起動すると、保存済み MCP 設定を読み込む可能性が確認されました。一方、`HOME` や XDG 系ディレクトリを完全に隔離すると、保存済み MCP は遮断できるものの Devin の認証も失われました。

この結果が示すのは、**Devin CLI の設定隔離と認証維持を同時に保証できない**ことです。ACP が他の Devin CLI モードより危険であることや、`--print` へ変更すれば解決することは証明されていません。

したがって採用判断は次のとおりです。

- 通信方式は、構造化イベント、permission、cancel、session 管理を利用できる ACP を採用する
- MCP 継承は Devin CLI 共通の実行環境制約として扱う
- 実行前診断で警告し、対話実行では確認を取る
- 検知可能な予期しない MCP 接続は prompt 前に停止する
- credential のコピーや Meguribi 独自保存は行わない
- MCP を完全隔離済みとは表現しない

`DevinPrintAdapter` は、ACP の互換性が失われた場合のフォールバック候補に留めます。

### 8.5 入力と禁止事項

Devin に渡すもの:

- 承認済み Issue 本文・関連コメント
- Codex の `plan.json`
- 対象リポジトリの `AGENTS.md`
- `.meguribi.yml` から抽出した検証・禁止事項
- 変更可能範囲
- 成果物出力先

Devin に担当させないもの:

- Issue / PR の直接更新
- branch 作成
- commit / push / merge
- production deploy
- secret 取得
- worktree 外の変更
- `/handoff` やクラウドセッション作成

### 8.6 バージョン診断

起動前に `devin --version`、認証状態、`devin acp` の利用可否を確認します。バージョン文字列だけで安全性を断定せず、対応する機能 probe と最小 smoke test の結果を組み合わせます。

未対応バージョン、未認証、ACP 初期化失敗、予期しないプロセス終了では推測して継続しません。

## 9. GitHub 連携

MVP は `gh` CLI を利用し、実行前に version、認証、対象リポジトリを確認します。

主な操作:

- Issue / コメント / ラベル取得
- Meguribi 管理コメントの作成・更新
- Draft PR 作成
- PR / CI 状態取得

コマンド文字列を shell 経由で組み立てず、実行ファイルと引数配列を分けます。

## 10. Git 連携

主な操作:

```text
git remote get-url origin
git fetch origin <base>
git worktree add
git status --porcelain=v2
git diff --binary
git diff --numstat
git add -- <explicit paths>
git commit
git push -u origin <branch>
git worktree remove
```

自動 stage は Meguribi が確認した changed files だけを明示指定します。無条件の `git add -A` は使用しません。

## 11. 非対話モード

`--non-interactive` では次の場合に停止します。

- 必須ラベルがない
- 高リスク変更を検出した
- worktree / branch / PR の競合がある
- 不明または未対応の Devin CLI バージョン
- Devin が未認証
- ACP 初期化に失敗した
- 継承 MCP の扱いについて明示的な許可がない
- protected path の変更
- 自動修正上限に到達した
- 想定外の dirty state がある

安全側へ倒せない状況で推測して継続しません。
