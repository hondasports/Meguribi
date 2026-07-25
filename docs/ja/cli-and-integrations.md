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
- GitHub 認証
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

主要オプション:

- `--since <duration>`
- `--label <label>`
- `--input <file>`
- `--limit <number>`
- `--post-comment`

### `meguribi hypothesis`

課題候補または Issue から仮説を構造化します。

```bash
meguribi hypothesis owner/repo#123
```

出力:

- 観測と推測の分離
- 課題候補
- 原因仮説
- 解決仮説
- 反対仮説
- 検証方法
- 成功・失敗条件
- 根拠不足

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

Codex が対象リポジトリを読み取り、技術計画を作成します。

```bash
meguribi plan owner/repo#125
```

`plan` はコードを変更しません。

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

再開前に、branch、worktree、HEAD、Issue、PR が保存状態と一致するか確認します。差異がある場合は自動継続せず停止します。

### `meguribi measure`

Requirement / Feature Issue と PR から Measurement Issue の草案を作ります。

```bash
meguribi measure owner/repo#125 --period 14d
```

### `meguribi cleanup`

終了した Run の worktree と一時情報を整理します。

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

`--json` は人間向けログと混ぜず、stdout に最終 JSON だけを出します。進行ログは stderr へ出します。

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
  commandTemplate:
    - '{executable}'
    - '{promptFile}'
```

Devin の実際の CLI 引数は、導入されているバージョンに合わせて設定します。秘密情報やトークンは設定ファイルへ記述しません。

## 6. 設定の優先順位

低い順:

1. Meguribi 内蔵値
2. ユーザー設定 `~/.config/meguribi/config.yml`
3. リポジトリ設定 `.meguribi.yml`
4. 環境変数
5. CLI オプション

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

### 7.2 Thread の扱い

- ロールごとに Thread を分ける。
- 同じタスクの修正だけ既存 Thread を再開する。
- Thread ID を Run に保存する。
- BIZ の長い会話履歴を実装ロールへ直接渡さない。

```text
hypothesis thread
requirements thread
planning thread
review thread
```

### 7.3 権限

- discovery / hypothesis / require / plan / review: 読み取り専用
- Codex にコード変更を許可しないのが MVP の標準
- network access は既定で無効
- 必要な外部情報は Meguribi が取得し、入力成果物として渡す

### 7.4 構造化出力

Codex にはコマンドごとの JSON Schema を指定します。

自然文の最終回答を解析して制御フローを決めません。

## 8. Devin 連携

### 8.1 接続方式

初期実装は Devin CLI を子プロセスとして実行します。

```ts
export interface DevinAdapter {
  implement(input: ImplementationInput): Promise<ImplementationResult>;
  fix(input: FixInput): Promise<ImplementationResult>;
}
```

### 8.2 CLI 差異の吸収

Devin CLI のバージョンによって、非対話モード、プロンプトファイル、セッション再開、エクスポートの引数が変わる可能性があります。

そのため、次を設定またはバージョン別 driver に閉じ込めます。

- 実行ファイル
- 引数テンプレート
- プロンプトの渡し方
- 結果・セッション ID の取得方法
- 再開方法
- サンドボックス指定

起動時に `--version` 相当を実行し、未対応バージョンでは停止します。

### 8.3 入力

Devin に渡すのは次だけです。

- 承認済み Issue 本文・関連コメント
- Codex の `plan.json`
- 対象リポジトリの `AGENTS.md`
- `.meguribi.yml` から抽出した検証・禁止事項
- 変更可能範囲
- 成果物出力先

Codex の内部推論や全文会話ログは渡しません。

### 8.4 禁止事項

Devin に次を担当させません。

- Issue / PR の直接更新
- branch 作成
- commit / push
- merge
- production deploy
- secret 取得
- worktree 外の変更

### 8.5 Issue #3 ACP PoC 結果（2026-07-25）

`devin 3000.2.17` では `devin acp` が利用でき、TypeScript から stdio ACP 接続を確立できた。`initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/update` の受信を確認し、ACP SDK `1.3.0` で fixture worktree の `README.md` を変更できた。通常 checkout と worktree 外の変更は検出されなかった。

実機では prompt 完了後も子プロセスが常駐したが、これは ACP の通信失敗ではなく、CLI プロセスの終了処理として扱える。`stopReason` を保存し、stdin を閉じ、短い猶予後に `SIGTERM` を送り、必要なら強制終了する実装でセッションを安全に閉じられる。残留プロセスがないことも確認した。

- 空の `--config` を指定しても、CLI が保存済みの MCP 設定を自動接続し、外部 HTTP / stdio MCP の起動を試みた。Meguribi の PoC 制約である network、secret、外部サービスの非使用を ACP 起動だけでは保証できない。

したがって現時点の判断は「ACP は利用可能で、`SIGTERM` を含む終了処理を前提に MVP の採用候補とする」とする。ただし、MCP の自動接続を無効化または allowlist 制御できる CLI の対応 version / 設定が確認できるまで、本番連携へ統合しない。MCP 制御が解決できない場合の代替方式として `DevinPrintAdapter` を候補に残す。

## 9. GitHub 連携

MVP は `gh` CLI を利用します。

実行前に次を確認します。

```bash
gh --version
gh auth status
gh repo view owner/repo --json nameWithOwner,defaultBranchRef
```

主な利用操作:

- `gh issue view --json ...`
- `gh issue list --json ...`
- `gh issue comment`
- `gh issue edit`
- `gh pr list --json ...`
- `gh pr create --draft`
- `gh pr checks`

コマンド文字列を shell 経由で組み立てず、引数配列として実行します。

## 10. Git 連携

Git 操作も引数配列で実行します。

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

- 必須ラベルがない。
- 高リスク変更を検出した。
- worktree / branch / PR の競合がある。
- 不明な Devin CLI バージョン。
- protected path の変更。
- 自動修正上限に到達した。
- 想定外の dirty state がある。

安全側へ倒せない状況で推測して継続しません。
