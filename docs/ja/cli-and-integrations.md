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

### `meguribi doctor`

実装エージェント CLI（Devin または Cursor）の実行可否を機械的に診断します。`meguribi run` の preflight からも同じ診断 API（`diagnoseCursor` / `diagnoseDevin`）を利用します。

```bash
meguribi doctor
meguribi doctor --json
meguribi doctor --non-interactive
meguribi doctor --implementer cursor
```

確認内容:

- 設定された実装エージェント executable（Devin / Cursor / cursor-agent / agent）の解決
- `<executable> --version` の取得と parse（未知 version は無条件許可しない）
- `<executable> auth status` または `<executable> status` による認証状態（認証情報そのものは読み取らない）
- `<executable> acp --help` による ACP capability probe（session やネットワーク接続は開始しない）
- `inheritedMcpPolicy`（MCP を完全隔離できるとは表示しない）

人間向け表示例:

```text
✓ Agent CLI: 3000.2.17
✓ Authentication: authenticated
✓ ACP: supported
! Saved agent settings may include MCP servers. Meguribi cannot fully isolate MCP.
  Policy: warn
Runnable: yes
```

`--json` では `AgentDiagnosis` の安定 schema のみを stdout へ出力します。`runnable` が false のとき終了コードは非 0 です。`--non-interactive` かつ `inheritedMcpPolicy: warn` の場合は fail-closed で停止します。

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

承認済み Issue を実装し、検証し、Codex レビューを行い、Draft PR を作成します。CLI は `runDelivery` ユースケースを呼び出し、`AgentAdapter` port（本番は `createDevinAcpAdapter` または `createCursorAcpAdapter`）へ実装を委譲します。

```bash
meguribi run owner/repo#125
meguribi run owner/repo#125 --non-interactive --allow-inherited-mcp --json
```

主要オプション:

- `--repo-path <path>`
- `--implementer <devin|cursor>`
- `--base <branch>`
- `--no-commit`
- `--no-push`
- `--no-pr`
- `--non-interactive`
- `--allow-inherited-mcp`
- `--max-fix-attempts <number>`
- `--json`
- `--wait-checks`
- `--allow-risk <level>`
- `--dry-run`

`--json` では最終結果だけを stdout に出し、進行ログは stderr へ出します。Ctrl+C は `AbortSignal` 経由で Devin session の cancel / shutdown に伝播します。

本番の GitHub / Git / Verifier アダプターは port 経由で注入します。CLI 既定 wiring（`createDeliveryDeps`）は `createDevinAcpAdapter` と `FileSystemRunStore`、`createDefaultPolicyEngine` を使い、GitHub/Git は専用アダプター実装までの暫定として fake を接続します。`MEGURIBI_DELIVERY_FAKES=1` では Codex/Verifier も fake になります。このフラグ無しで Codex SDK を構築できない場合は silent な fake へ落ちず fail-closed します。fixture テストでは全 fake を使い、実 `gh` / 実 Devin は呼びません。

### `meguribi review`

既存 PR または Issue に紐づくブランチ差分を Codex でレビューします。

```bash
meguribi review owner/repo#125
meguribi review https://github.com/owner/repo/pull/456
```

### `meguribi resume`

中断した Run を最後に完了したステップから再開します。MVP では `implementation_completed` 以降（verify / review / publish）だけを再開対象とします。実装途中 session の resume は保証せず、identity（branch / worktree / HEAD / remote）不一致では停止します。

```bash
meguribi resume owner/repo#125
meguribi resume owner/repo#125 --run-id 20260725T120000Z-ab12cd
```

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

implementer: devin

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

cursor:
  executable: cursor
  startupTimeoutMs: 10000
  turnTimeoutMinutes: 45
  inheritedMcpPolicy: warn
```

`transport: acp` が MVP の標準です。秘密情報やトークンは設定ファイルへ記述しません。

`inheritedMcpPolicy` は、実装エージェント CLI が利用者の保存済み MCP 設定を継承する可能性をどう扱うかを表します。

- `warn`: 対話実行では警告を表示し、利用者へ確認する
- `deny`: MCP 接続を検知した場合に停止する
- `allow`: 利用者の agent 設定を明示的に受け入れる

MVP の既定値は `warn` とします。非対話実行では `warn` を許可せず、`allow` または `deny` を明示しない限り安全側へ停止します。MCP を完全に隔離できると表現してはいけません。

`transport` は MVP では `acp` だけを受け付けます。`executable` は単一の実行ファイル名またはパスです。コマンド引数（`devin acp` など）、`--token=SECRET` のような flag や環境変数代入、`http://...` や `file://...` のような URL scheme は受け付けません。空白を含まないパスは文字列、空白を含むパスは必ず1要素の配列で指定します（例：`["C:\\Program Files\\Devin\\devin.exe"]`、`["/my dir/bin/devin"]`）。配列が2要素以上になることはありません。これにより command-line argument を executable path と曖昧にできません。環境変数 `MEGURIBI_DEVIN_EXECUTABLE` では空白を含むパスを `'["C:\\\\Program Files\\\\Devin\\\\devin.exe"]'` のような JSON 1要素配列で指定してください。文字列のままでは空白を含む path は受け付けません。すべての timeout は 1 以上の整数で、ms 単位の timeout は setTimeout の 32-bit 上限未満（約24.8日未満）、`turnTimeoutMinutes` はその分換算で同じ上限未満です。無効化または無限待機にはできません。未知の設定キーと未知の policy は validation error とします。shell command template、credential path、token、cookie は設定項目に含めません。

## 6. 設定の優先順位

低い順:

1. Meguribi 内蔵値
2. ユーザー設定。`XDG_CONFIG_HOME` が設定されていれば `$XDG_CONFIG_HOME/meguribi/config.yml`、Windows では `%APPDATA%\meguribi\config.yml`（または `%LOCALAPPDATA%`）、それ以外では `~/.config/meguribi/config.yml`
3. リポジトリ設定 `.meguribi.yml`
4. 環境変数
5. CLI オプション

環境変数では、`MEGURIBI_IMPLEMENTER`、`MEGURIBI_DEVIN_EXECUTABLE`、`MEGURIBI_DEVIN_TRANSPORT`、`MEGURIBI_DEVIN_INHERITED_MCP_POLICY`、各 timeout に対応する `MEGURIBI_DEVIN_*`、`MEGURIBI_CURSOR_EXECUTABLE`、`MEGURIBI_CURSOR_INHERITED_MCP_POLICY`、および各 timeout に対応する `MEGURIBI_CURSOR_*` だけを受け付けます。任意の環境変数、token、cookie は設定へ取り込みません。

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

### 7.4 planning / review adapter の実行規則

`@meguribi/adapters` は `@openai/codex-sdk` を adapter 内だけで利用し、次の2つの read-only 操作を提供します。

- `createPlan`: Issue、完了条件、対象外、repository rules から `plan.json` を生成する。
- `review`: Issue、plan、Git diff、verification から `review.json` を生成する。

planning と review は `sandboxMode: read-only`、`approvalPolicy: never`、network access 無効で起動します。実行前後の workspace snapshot が一致しない場合は `policy_blocked` として停止します。

Codex の structured output は runtime schema と JSON Schema の両方で検証します。不正な JSON / schema は最大1回だけ validation error のみを含む repair prompt で再試行し、再度失敗した場合は成功扱いにしません。timeout、cancel、空レスポンス、stream interruption、process failure は分類済みエラーへ変換します。

`thread ID`、source digest、実行時間、redaction 済み event log は Meguribi 所有の artifact metadata として保存します。planning は Issue の digest、review は Issue、plan、diff、verification の canonical JSON digest を検証し、不一致なら Codex を起動しません。Codex の review approval は publish、Draft 解除、merge の許可を意味しません。

## 8. Devin 連携

### 8.1 採用する接続方式

MVP は `DevinAcpAdapter` を採用し、Meguribi が `devin acp` を Issue 専用 worktree を `cwd` として子プロセス起動します。人間が事前に Devin CLI を起動しておく必要はありません。

```text
Meguribi
  -> DevinAcpAdapter
      -> DevinAcpTransport / session
          -> @agentclientprotocol/sdk (adapter 内のみ)
          -> ManagedProcess (`devin acp`)
```

```ts
export interface DevinAdapter {
  implement(input: ImplementationInput): Promise<ImplementationResult>;
  fix(input: FixInput): Promise<ImplementationResult>;
}
```

`@agentclientprotocol/sdk` は `@meguribi/adapters` の依存としてのみ使用する。SDK の request / event / error 型を core・CLI・RunStore へ漏らさない。transport は `ManagedProcess` で `devin acp` を起動し、`initialize` / `session/new` / `session/prompt` / `session/update` を扱う。stdout は ACP 通信専用、stderr は診断ログとして分離する。permission の PolicyEngine 仲介と完全な shutdown シーケンスは後続 Issue で完成させる。

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

### 8.6 バージョン診断 / preflight

起動前に `meguribi doctor` と同じ診断を実行します。

- `devin --version`
- 認証状態（`devin auth status`）
- `devin acp --help` による ACP capability probe
- `inheritedMcpPolicy`

バージョン文字列だけで安全性を断定しません。パース不能な version は `unknown` とし、ACP probe 成功を必須とします。パース可能な version は `MINIMUM_SUPPORTED_DEVIN_CLI_VERSION`（既定 `3000.0.0`）未満なら `unsupported_version` とします。`--version` の非ゼロ終了や timeout は fail-closed です。ACP 欠如は `capability_missing` として区別します。未対応バージョン、未認証、ACP 非対応、非対話での曖昧な MCP ポリシー、予期しないプロセス終了では推測して継続しません。診断ログへは secret らしき文字列を残しません。

`meguribi run` / `resume` は `@meguribi/core` の `runDelivery` / `resumeDelivery` を呼び出します。Devin preflight では `@meguribi/adapters` の `preflightDevin` / `assertDevinRunnable` を必須とします。本番 facade は `createDevinAcpAdapter` で、`implement` / `fix` を `DevinAdapter` port として提供します。Codex の `analyzeFailure` は未実装のため、fix instruction は verification / review 証拠から `buildFixInstruction` が組み立てます。

### 8.7 fake Devin / ACP の総合テスト

通常の CI では実 Devin CLI、GitHub、Codex SDK、外部 MCP、credential を使用しません。`packages/adapters/src/devin/fixtures/fake-devin.js` が CLI 互換入口を提供し、次の環境変数で ACP の挙動を選択します。

```text
MEGURIBI_FAKE_DEVIN_SCENARIO=success
MEGURIBI_FAKE_DEVIN_SCENARIO=permission-denied
MEGURIBI_FAKE_DEVIN_SCENARIO=mcp-detected
MEGURIBI_FAKE_DEVIN_SCENARIO=timeout
```

fake executable は `--version`、`auth status`、`acp --help`、`acp` を実装します。既存の下位コンポーネントテストで使う `FAKE_DEVIN_MODE` と `FAKE_ACP_MODE` も互換のため利用できます。新しい scenario を追加する場合は、fake Devin の preflight/ACP マッピング、fake ACP の protocol・filesystem 動作、対象 adapter の integration test、workflow を横断する場合の process-boundary test を同じ変更で追加します。各 test は一時 directory を使い、終了後に `termination.json` の残留プロセス数を確認します。

## 8.8 実 Devin CLI compatibility smoke

Issue #24 の実機 compatibility smoke は、通常の delivery workflow・`pnpm test`・CI から分離した手動確認です。`experiments/devin-acp` の専用 script を使い、既存の `DevinAcpAdapter` facade、temporary Git repository、Issue 模擬 worktree を通して ACP lifecycle を確認します。

```powershell
$env:MEGURIBI_RUN_REAL_DEVIN_SMOKE = "1"
pnpm smoke:devin-acp -- --yes
```

実行前に警告を表示し、TTY では確認プロンプトを出します。非対話実行では `--yes` を付与してください。次の場合は外部agentを起動せず、または途中で停止します。

- 明示opt-inがない。
- Devin CLIが未認証、ACP非対応、または診断不能である。
- 非対話実行で継承MCPの扱いが明示されていない。
- worktree外変更、protected path変更、Git境界違反を検出した。
- stdin close、SIGTERM、必要時force termination、process残留確認が完了しない。

実行対象は一時fixtureだけです。commit、push、PR、Issue更新、実在repositoryの変更、外部MCP接続は行いません。保存済みDevin設定と認証の完全な同時隔離は保証できないため、credentialをコピー・保存せず、MCP完全隔離とも表現しません。`compatibility-result.json` と raw/normalized event artifact の exit code・内容を結果の根拠にします。

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
