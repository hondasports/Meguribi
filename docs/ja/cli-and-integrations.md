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

現在 CLI に実装されているコマンドは `init`、`doctor`、`desk`、`discover`、`hypothesis`、`promote`、`explore`、`require`、`plan`、`review`、`run`、`resume`、`status`、`workflow`、`discuss`、`say`、`approve`、`reject`、`measure`、`cleanup` です。

### Command Desk（ローカル UI）

コマンドライン入力を省略したい場合は、Command Desk（`apps/web` の Vite + Vue UI）を起動できます。

```bash
meguribi desk
meguribi desk --port 4199
```

`meguribi desk` は Meguribi リポジトリのルートで `pnpm --filter @meguribi/web dev` を引数配列として起動し、表示された URL（既定は `http://127.0.0.1:4173`）を開いて使います。子プロセスの終了コードはそのまま CLI の終了コードになります。

初期画面の `相談` タブでは、大きな複数行入力に相談内容を書き、実設定から取得した参加エージェントを 2〜4 件選んで開始できます。Issue target は任意の補助入力です。候補と既定選択は `GET /api/discussion/profiles`、開始は `POST /api/discussions` を使います。Issue target を付けた通常開始でも、実装・push・Draft PR 作成へ自動では進みません。実装まで進める `discuss-to-pr` は、明示的に選択した workflow だけです。

開始後は同じ画面の先頭に、実際の相談内容、話者別の会話、追加入力が表示されます。大きな新規入力フォームは畳まれ、小さな `新しい相談` ボタンから入力画面へ戻れます。`相談へ戻る` で進行中の会話へ復帰できます。

`既存操作` タブでは、許可された Meguribi コマンドを選択して実行できます。画面は任意のシェルコマンドを受け付けず、検証済みのコマンド名とオプションを引数配列としてローカルの Meguribi CLI に渡します。`Run履歴` タブでは、RunStore に保存された最近の Run 一覧、delivery 工程、エージェントの活動状態、ライブログを表示します。

Issue を持たない相談は `command: "consult"` の Run として `consultations/<runId>` に保存され、`issueNumber` / `branch` / `baseRef` / `baseSha` / `headSha` は `null` です。Issue に紐付く従来の議論 Run は `command: "discuss"` を維持します。`consult` / `discuss` の発言は `replyTo` に沿ったスレッドで表示し、話者ごとの色と話者名で区別します。形式不正のターンには目印を付け、結論に含まれる turn ID から該当ターンへスクロールできます。

議論エンジンが動いている Run では、発言挿入欄から人間の発言を送れます。送信はサーバーが `meguribi say <runId> <message>` を引数配列で起動して行い、サーバー自身は `inbox/` を直接書き換えません。Issue に紐付く従来の `discuss` Run が `awaiting_human` のときは、画面内の確認表示から承認または却下・再議論を実行できます。`consult` は結論保存後に完了し、実装・PR 作成へは進みません。

認証・リモート公開・マルチユーザー運用は提供しません。詳細は `apps/web/README.md` を参照してください。

### `meguribi init`

対象リポジトリを Meguribi で扱えるか診断し、設定ファイルの雛形を生成します。

```bash
meguribi init --implementer devin ./path/to/repository
```

`--implementer <profile>` で診断する実装エージェントを明示します。`devin`、`cursor`、`claude-code`、`codex-acp`、または `.meguribi.yml` の `agents` で定義したプロファイル ID を指定できます。既存の `.meguribi.yml` は上書きせず、存在しない場合だけ雛形を作成します。`--json` は診断結果だけを stdout へ出力し、問題がある場合は非 0 で終了します。

確認内容:

- Git リポジトリか
- remote と GitHub リポジトリが一致するか
- `git`、`gh`、選択した実装エージェントの利用可否
- GitHub と選択した実装エージェントの認証状態
- default branch
- `git` と `gh` の version

Codex は PATH 上の `codex` CLI としてではなく、Meguribi の `@openai/codex-sdk` 依存として adapter 内から利用します。そのため `init` は `codex --version` を実行しません。SDK の実接続は `plan` / `review` の実行時に確認します。
- 選択した実装エージェントの ACP readiness
- `.meguribi.yml` の存在と生成結果

package manager、検証コマンド候補、`AGENTS.md`、必要ラベルの詳細診断は後続の delivery CLI で扱います。

GitHub へは書き込みません。必要ラベルの自動作成（`--apply-labels`）は未実装で、ラベル不足は後続の delivery workflow で停止します。

### `meguribi doctor`

実装エージェント CLI（Devin / Cursor / Claude Code ACP / Codex ACP）の実行可否を機械的に診断します。`meguribi run` の preflight からも同じ診断 API（`diagnoseCursor` / `diagnoseDevin` / `diagnoseAcpServer`）を利用します。

```bash
meguribi doctor
meguribi doctor --json
meguribi doctor --non-interactive
meguribi doctor --implementer cursor
```

確認内容:

- 設定された実装エージェント executable（Devin / Cursor / cursor-agent / agent / claude-agent-acp / codex-acp）の解決
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

既存 Issue、指定資料、任意の利用データから、根拠への参照を持つ課題候補を抽出します。観測と推測を分離し、候補はローカルの `discoveries/<owner>/<repo>/discovery.json` に保存します。Issue は自動作成しません。

```bash
meguribi discover owner/repo --since 30d --limit 5
meguribi discover owner/repo --input observations.md --label product:discovery --json
```

既定では候補をローカルに保存し、Issue を自動作成しません。

### `meguribi hypothesis`

Issue 本文の `観測`、`課題候補`、`原因仮説`、`解決仮説`、`反対仮説`、`検証方法`、`成功条件`、`失敗・棄却条件` の節だけを仮説成果物へ構造化します。未提示の内容は推測せず `missingEvidence` に記録し、人間承認が必要な草案としてローカル保存します。Issue コメントは stable marker で冪等更新します。

```bash
meguribi hypothesis owner/repo#123
```

### `meguribi promote`

`product:validated` ラベルの付いた Hypothesis Issue から、解決策を固定しない Problem Issue の草案を生成します。既定ではローカル成果物と元Issueのコメントだけを更新し、`--create-issue` を指定した場合だけ対話的な人間確認後に新規Issueを作成します。観測または課題候補が不足している場合は停止します。

```bash
meguribi promote owner/repo#123
```

既定動作は草案表示です。`--create-issue` で人間確認後に新規 Issue を作成します。

### `meguribi explore`

Problem Issue 本文の `解決方針` / `解決仮説` を複数案として比較します。入力にない評価は `null` とし、採用案を自動選択しません。案が2つ未満の場合は停止します。

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

`product:approved` の Issue から、`--solution <number>` で選択した解決方針を Requirement / Feature Issue の草案へ変換します。要件、受け入れ条件、スコープ、指標などの不足情報は `openQuestions` に残し、推測で補完しません。

```bash
meguribi require owner/repo#124 --solution 2
```

### `meguribi plan`

Codex が対象リポジトリを読み取り、技術計画を作成します。`plan` はコードを変更しません。

```bash
meguribi plan owner/repo#125
meguribi plan owner/repo#125 --request "WEBでTODOアプリを作って。"
```

`plan` は実装エージェントを起動せず、計画を
`~/.local/share/meguribi/plans/<owner>/<repo>/issue-<number>/plan.json`
（Windows は `%LOCALAPPDATA%\\meguribi\\plans\\...`）へ atomic write します。
同時に `<!-- meguribi:implementation-plan -->` marker 付きの Issue コメントを作成または更新します。
ローカル fixture では `--local --repo-path <path>` を使用できます。`--json` は計画と成果物パスを JSON で出力します。
`--request <text>` を指定すると、Issue 本文とは別に今回のユーザー要望をCodexへ渡せます。例えば「WEBでTODOアプリを作って。」のような追加要件を入力できます。要望は読み取り専用の計画材料として扱われ、コード変更や権限変更を許可するものではありません。空文字は受け付けず、12,000文字以内です。

### `meguribi run`

承認済み Issue を実装し、検証し、Codex レビューを行い、Draft PR を作成します。CLI は `runDelivery` ユースケースを呼び出し、`AgentAdapter` port（本番は `createDevinAcpAdapter`、`createCursorAcpAdapter`、または `createAcpServerImplementer`）へ実装を委譲します。

```bash
meguribi run owner/repo#125
meguribi run owner/repo#125 --non-interactive --allow-inherited-mcp --json
```

主要オプション:

- `--repo-path <path>`
- `--implementer <profile>`（`devin`、`cursor`、`claude-code`、`codex-acp`、または `.meguribi.yml` のプロファイル ID）
- `--log <stream|compact|none>`
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

`--json` では最終結果だけを stdout に出し、進行ログは stderr へ出します。Ctrl+C は `AbortSignal` 経由で選択した Agent session の cancel / shutdown に伝播します。

本番の GitHub / Git / Verifier アダプターは port 経由で注入します。CLI 既定 wiring（`createDeliveryDeps`）は実 `gh` / `git` / Verifier、役割割り当てに応じた planner / reviewer bridge、そして明示された実装エージェントの `createDevinAcpAdapter` / `createCursorAcpAdapter` / `createAcpServerImplementer` を選択し、`FileSystemRunStore` と `createDefaultPolicyEngine` を使います。`MEGURIBI_DELIVERY_FAKES=1` を明示した場合だけ、fixture 用に GitHub/Git/Codex/Verifier を fake にします。このフラグ無しで外部 adapter を構築できない場合は silent な fake へ落ちず fail-closed します。fixture テストでは全 fake を使い、実 `gh` / 実 Agent CLI は呼びません。

### `meguribi review`

既存の delivery Run の worktree 差分を Codex で再レビューします。`implementation_completed` と
`plan.json`、`implementation-result.json`、`verification.json` が必要です。Run の branch、HEAD、remote
identity が保存状態と一致しない場合は停止します。`review` はコードを変更せず、`review.json` と
`<!-- meguribi:code-review -->` marker 付き Issue コメントだけを更新します。

```bash
meguribi review owner/repo#125
meguribi review owner/repo#125 --run-id 20260725T120000Z-ab12cd
```

主要オプションは `--run-id`、`--repo-path <path>`、`--local`、`--json` です。

### `meguribi resume`

中断した Run を最後に完了したステップから再開します。MVP では `implementation_completed` 以降（verify / review / publish）だけを再開対象とします。実装途中 session の resume は保証せず、identity（branch / worktree / HEAD / remote）不一致では停止します。

```bash
meguribi resume owner/repo#125
meguribi resume owner/repo#125 --run-id 20260725T120000Z-ab12cd
```

### `meguribi status`

`run` / `resume` が Run ディレクトリへ追記する `events.jsonl` と `state.json` から、Run の状態とエージェント活動を表示します。Run ID は `meguribi run` / `resume` の出力にある `Run:` 行で確認できます。

```bash
meguribi status 20260725T120000Z-ab12cd
meguribi status 20260725T120000Z-ab12cd --follow
meguribi status 20260725T120000Z-ab12cd --follow --agent devin
meguribi status 20260725T120000Z-ab12cd --json
```

主要オプション:

- `--follow`: `events.jsonl` を追従し、表示可能な工程イベントとエージェントイベントをライブログ形式で表示する
- `--agent <profileId>`: 指定したエージェントプロファイルのイベントだけを表示する
- `--json`: Run 状態と `deriveAgentActivity` が導出した活動状態を JSON で出力する
- `--runs-root <path>`: RunStore のルートを明示する

`events.jsonl` は JSON Lines で、1 行ごとに次の envelope を持ちます。

```json
{"at":"2026-11-28T12:00:00.000Z","event":{"type":"step.progress","runId":"20260725T120000Z-ab12cd","stepId":"verify","label":"verify","current":1,"max":2,"at":"2026-11-28T12:00:00.000Z"}}
```

`event` には `workflow.started`、`workflow.step.started`、`workflow.step.completed`、`workflow.step.failed`、`workflow.finished`、工程内の `step.started` / `agent.event`、回数や件数を示す `step.progress`、議論の `discussion.turn` / `discussion.ended` が入ります。保存前に secret redaction を行い、append の失敗は Run の結果や終了コードを変えず stderr に 1 回だけ警告します。読み出し時に壊れた行があれば、その行だけを飛ばして警告します。

実行中の Run を分割画面で追う例:

```bash
# pane 1: delivery を実行
meguribi run owner/repo#125 --log compact

# pane 2: Run ID が表示されたら全体を追従
meguribi status 20260725T120000Z-ab12cd --follow

# pane 3: implementer だけを追従
meguribi status 20260725T120000Z-ab12cd --follow --agent devin
```

Ghostty では split right / split down で pane を分けて同じコマンドを実行できます。tmux では次のように分割できます。

```bash
tmux split-window -h 'meguribi status 20260725T120000Z-ab12cd --follow'
tmux split-window -v 'meguribi status 20260725T120000Z-ab12cd --follow --agent devin'
```

### `meguribi workflow`

宣言的ワークフロー定義を検査します。

```bash
meguribi workflow validate .meguribi/workflows/discuss-to-pr.yml
meguribi workflow list --repo-path .
```

`workflow validate <file>` は YAML を parse し、工程 ID、参照、上限付きループ、publish 前の verify / review などの静的制約を検証します。`workflow list` は組み込み `delivery` の工程 ID と、`<repo>/.meguribi/workflows/*.yml` / `*.yaml` にあるワークフローの工程 ID を一覧します。壊れたファイルは一覧を停止せず、そのファイルの error 行として表示します。

### `meguribi discuss`

組み込み `discuss` ワークフロー（`discuss` → `approve`）を実行し、2〜4人の read-only の discussant に議論させ、summarizer が `DiscussionConclusion` を作成します。結論を自動承認せず、`--non-interactive` でも `awaiting_human` で停止します。

```bash
meguribi discuss owner/repo#125
meguribi discuss owner/repo#125 --request "通知タイミングを重点的に" --max-turns 20 --log compact
```

主要オプションは `--repo-path <path>`、`--local`、`--request <text>`、`--discussants <ids>`、`--summarizer <id>`、`--discussion-mcp-policy <deny|allow>`、`--max-turns <n>`、`--log <stream|compact|none>`、`--json`、`--non-interactive` です。`--max-turns` の既定値は 20 です。議論全体の既定上限は 30 分、1ターンの既定タイムアウトは 5 分で、同じ参加者が 2 回連続でタイムアウトした場合も議論を終了します。

`--discussion-mcp-policy` は議論 Run だけの明示選択です。`deny` は検出した MCP 接続を停止し、`allow` はこの Run に限って保存済み MCP 設定の継承を許可します。未指定時は従来どおりプロファイルの `inheritedMcpPolicy` に従うため、`warn` は `--non-interactive` では fail-closed で停止します。設定または診断対象のどちらかが固定 `deny` なら、`allow` を選んでも `deny` は弱めません。この選択は永続設定にも redo 入力にも保存されず、summarizer を含む議論役割だけに適用され、`run` / `discuss-to-pr` の implementer や delivery 側 `--allow-inherited-mcp` には波及しません。

`--log stream` では `discussion.turn` を話者・指名先・ターン数付きで表示し、`discussion.ended` を終了境界として表示します。`compact` ではターン見出しと発言の冒頭 80 文字だけを表示します。形式不正の発言には `(形式不正)` を付けます。

議論が終わると結論、論点ごとの立場、不採用案を表示し、`awaiting_human` で停止します。次の操作は `meguribi approve <runId>` または `meguribi reject <runId> --reason "..." [--redo]` です。

### `meguribi say`

エージェントが議論を続けている最中の Run の `inbox/` へだけ、人間の発言を書き込みます。エンジンはターンの合間に未処理の発言を取り込み、話者 `human` のターンとして記録します。`awaiting_human` の承認待ち Run では議論エンジンが停止しているため、発言は受け付けず exit 1 です。

```bash
meguribi say 20260725T120000Z-ab12cd "既存の設定画面は変えたくない"
```

対象 Run が `command: "discuss"` でない場合、`awaiting_human` の承認待ちである場合、またはすでに完了している場合は exit 1 です。発言は 4,000 文字までで、超過分は切り捨てられます。

### `meguribi approve`

`awaiting_human` の議論 Run の結論を承認します。`approval.json` には承認者、日時、承認した `discussion/conclusion.json` のハッシュ、任意コメントを保存し、Run を `completed` にします。

```bash
meguribi approve 20260725T120000Z-ab12cd
meguribi approve 20260725T120000Z-ab12cd --comment "この方向で進める"
```

承認後に `discussion/conclusion.json` が書き換えられた場合、後続工程はハッシュ不一致で停止します。

### `meguribi reject`

`awaiting_human` の議論 Run の結論を却下します。`--reason` は必須です。`--redo` を付けると、理由を次の議論へ `<untrusted-redo-note>` として渡し、`discuss` 工程からやり直します。やり直しは Run あたり最大 2 回です。

```bash
meguribi reject 20260725T120000Z-ab12cd --reason "通知量の上限も検討して"
meguribi reject 20260725T120000Z-ab12cd --reason "前提が違う" --redo
```

議論の記録は Run ディレクトリの `discussion/transcript.jsonl`、`discussion/conclusion.json`、`approval.json`、`inbox/` に保存されます。`inbox/` で処理済みになった発言は `inbox/processed/` へ移動します。

### `meguribi measure`

Requirement / Feature Issue の delivery summary からマージ済み PR を復元し、指定期間の Measurement 草案を作ります。元の仮説、指標、定性的反応が無い場合は推測せず `openQuestions` に残し、結果と判断は人間に委ねます。

```bash
meguribi measure owner/repo#125 --period 14d
```

### `meguribi cleanup`

終了した Run の worktree を整理します。PR がクローズまたはマージ済みで、保存済みの branch / HEAD / remote と PR の HEAD が一致し、作業ツリーが clean の場合だけ削除します。未マージ・未保存・識別子不一致の変更は削除しません。Run artifact は保持します。

```bash
meguribi cleanup owner/repo#125
meguribi cleanup owner/repo#125 --dry-run
meguribi cleanup owner/repo#125 --delete-branch
```

`--delete-branch` はマージ済み PR のローカル branch だけを追加で削除します。remote branch は削除しません。

## 3. 共通オプション

```text
--config <path>
--json
--verbose
--quiet
--non-interactive
--dry-run
--run-id <id>
--delete-branch
--log <stream|compact|none>
```

`--json` は stdout に最終 JSON だけを出し、進行ログは stderr へ出します。`run` / `resume` の `--log stream`（既定）では、implement・plan・review の各工程で ACP エージェントの発言、ツール呼び出し、権限判定を起きた順に stderr へ流します。`compact` は工程の切り替わりと要約だけ、`none` はライブログを出しません。`--json` 指定時は `none` 扱いです。

```text
── plan · Claude Code (planner) ────────────────────────────────
● Claude Code  対象コードと既存テストを確認します。
● Read  src/feature.ts
  └ completed
── implement · Devin (implementer) ─────────────────────────────
● Edit  src/feature.ts
  └ completed · src/feature.ts
── review · Codex (reviewer) ───────────────────────────────────
● Codex  完了条件と差分を照合します。
```

ACP の役割エージェントを使わない Codex SDK 経路では、従来どおり工程進捗だけが表示されます。

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

agents:
  review-claude:
    kind: claude-code
    transport: acp
    executable: claude-agent-acp
    startupTimeoutMs: 10000
    turnTimeoutMinutes: 45
    inheritedMcpPolicy: warn

roles:
  discussants: [claude-code, codex-acp, review-claude]
  summarizer: review-claude
  planner: codex
  implementer: devin
  reviewer: review-claude
  allowSameImplementerReviewer: false

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

組み込みプロファイルは `claude-code`、`codex`（Codex SDK）、`codex-acp`、`devin`、`cursor` の5つです。`agents` では同じ `kind` / `transport` / timeout / `inheritedMcpPolicy` を持つ別プロファイルを定義できます。`roles` は `discussants`、`summarizer`、`planner`、`implementer`、`reviewer` などの役割へプロファイル ID を割り当てます。`roles.discussants` は議論に参加させる 2〜4 件のプロファイル ID で、重複はできません。`roles.summarizer` を省略した場合は `discussants` の先頭を使います。議論の役割には `transport: acp` のプロファイルだけを指定でき、`codex`（`transport: sdk`）は議論では `transport_unsupported` です。`roles.implementer` にも `transport: acp` のプロファイルだけを指定でき、`allowSameImplementerReviewer: true` を明示しない限り `implementer` と `reviewer` に同じプロファイルを割り当てられません。`codex`（`transport: sdk`）は計画・レビューの互換経路として使えますが、実装担当には使えません。

`planner` と `reviewer` には、`codex`（`transport: sdk`）、`claude-code` / `codex-acp` などの単体 ACP サーバー、および `devin` / `cursor` のプロファイルを割り当てられます。`kind` が `devin` / `cursor` の場合、CLI はそれぞれ `devin` / `cursor` 設定の `executable` と `inheritedMcpPolicy` で診断し、`acp` サブコマンド付きで read-only の役割セッションとして起動します。役割セッション本体の startup / turn timeout と `inheritedMcpPolicy` には、割り当てたプロファイルの値を使います。`devin` / `cursor` も `transport: acp` のプロファイルとして議論の役割に割り当てられます。

Claude Code / Codex ACP を使う場合は、それぞれ次のパッケージを利用者が明示的に導入し、認証済みであることを確認してください。

```bash
npm i -g @agentclientprotocol/claude-agent-acp
npm i -g @agentclientprotocol/codex-acp
```

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
- discovery / require / plan / review は読み取り専用。hypothesis は成果物を保存し、既存 Issue の草案コメントだけを stable marker で更新する
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

## 8. ACP 実装エージェント連携

Devin と Cursor は `AgentAdapter` port を共有します。ACP SDK 型、実行ファイル名、診断、prompt、成果物ストア、transport は各 adapter の内側に閉じ込め、delivery workflow は正規化された `ImplementationResult` だけを受け取ります。

### 8.1 ACP 接続方式

MVP は明示された implementer に応じて `DevinAcpAdapter` または `CursorAcpAdapter` を使います。以下は Devin の例です。Meguribi が `devin acp` を Issue 専用 worktree を `cwd` として子プロセス起動し、人間が事前に Devin CLI を起動しておく必要はありません。

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

`@agentclientprotocol/sdk` は `@meguribi/adapters` の依存としてのみ使用する。SDK の request / event / error 型を core・CLI・RunStore へ漏らさない。各 transport は選択した ACP executable を `ManagedProcess` で起動し、`initialize` / `session/new` / `session/prompt` / `session/update` を扱う。stdout は ACP 通信専用、stderr は診断ログとして分離する。permission の PolicyEngine 仲介と共通の冪等な shutdown シーケンスは adapter 境界で強制する。

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

実装エージェントに担当させないもの:

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

`meguribi run` / `resume` は `@meguribi/core` の `runDelivery` / `resumeDelivery` を呼び出します。preflight では選択した Agent の診断 API（`preflightDevin` / `assertDevinRunnable` または `preflightCursor` / `assertCursorRunnable`）を必須とします。本番 facade は `createDevinAcpAdapter` または `createCursorAcpAdapter` で、`implement` / `fix` を `AgentAdapter` port として提供します。Codex の `analyzeFailure` は未実装のため、fix instruction は verification / review 証拠から `buildFixInstruction` が組み立てます。

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

## 8.9 実 Cursor CLI compatibility smoke

Issue #32 の実機 compatibility smoke は、通常の delivery workflow・`pnpm test`・CI から分離した手動確認です。`experiments/cursor-acp` の専用 script を使い、既存の `createCursorAcpAdapter` facade、temporary Git repository、Issue 模擬 worktree を通して ACP lifecycle を確認します。

```powershell
$env:MEGURIBI_RUN_REAL_CURSOR_SMOKE = "1"
pnpm smoke:cursor-acp -- --yes
```

実行前に警告を表示し、TTY では確認プロンプトを出します。非対話実行では `--yes` を付与してください。次の場合は外部agentを起動せず、または途中で停止します。

- 明示opt-inがない。
- Cursor CLIが未認証、ACP非対応、または診断不能である。
- 非対話実行で継承MCPの扱いが明示されていない。
- worktree外変更、protected path変更、Git境界違反を検出した。
- stdin close、SIGTERM、必要時force termination、process残留確認が完了しない。

実行対象は一時fixtureだけです。commit、push、PR、Issue更新、実在repositoryの変更、外部MCP接続は行いません。保存済みCursor設定と認証の完全な同時隔離は保証できないため、credentialをコピー・保存せず、MCP完全隔離とも表現しません。`compatibility-result.json` と raw/normalized event artifact の exit code・内容を結果の根拠にします。

fake ACP server を使う smoke は以下の通りです。

```powershell
pnpm smoke:cursor-acp:fake
$env:MEGURIBI_FAKE_CURSOR_SCENARIO = "write-outside"
pnpm smoke:cursor-acp:fake
```

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

## 12. discuss-to-pr ワークフロー

組み込み `discuss-to-pr` ワークフローは、Issue の議論から仕様化、実装、検証、レビュー、Draft PR 作成までを1つの宣言的ワークフローとして実行します。工程は `discuss → approve → specify → plan → implement → verify → review → publish` で、検証失敗時は `fix-after-verify`、レビュー修正要求時は `fix-after-review` へ上限付きで遷移します。

```bash
meguribi workflow run discuss-to-pr owner/repo#123 \
  --repo-path /path/to/repo \
  --request "補足の相談内容"
```

主なオプションは `--local`、`--implementer <profile>`、`--allow-inherited-mcp`、`--non-interactive` です。実行可能な組み込みワークフローは現在 `discuss-to-pr` のみです。議論だけ行う場合は `meguribi discuss`、従来の delivery だけを行う場合は `meguribi run` を使います。

第1フェーズでは、read-only の discussant が議論し、summarizer が結論を作ります。結論を自動承認せず、`--non-interactive` でも `awaiting_human` で停止します。継続に必要な設定は `discuss-to-pr.json` として Run 単位で保存され、承認待ち状態が外部から見える前に書き込まれます。

```bash
meguribi approve <runId>
meguribi reject <runId> --reason "やり直したい点" [--redo]
```

`approve` は承認者、時刻、結論ハッシュを `approval.json` に記録します。`discuss-to-pr` の Run では承認後に同じコマンドが `specify` 以降へ進みます。継続が途中で失敗した場合も、承認を二重記録せず `meguribi approve <runId>` で再開できます。再開時は `steps/<stepId>.json` の未完工程を優先し、完了済み工程の outcome に従うため、完了後の再実行では implement や Draft PR 作成を繰り返しません。`reject` は実装へ進まず、`--redo` の場合だけ議論をやり直します。

`publish` 工程は step の完了とは別に、実際の公開結果を `publish-outcome.json` へ保存します。Draft PR 作成まで完了した場合だけ `published` です。policy block や publish 副作用前の cancel は `unpublished_retryable` なので、条件修正後の再開では publish だけを retry します。`noPr` で PR を作らない完了は `unpublished_terminal` として retry しません。push や PR 作成などの副作用途中で失敗した可能性がある publish は自動 retry せず、人手で worktree・remote・PR を確認してください。

`specify` 工程では read-only の specifier が承認済み結論から `requirement.json` と `specification.json` を作ります。承認時の結論ハッシュと現在の結論が一致しない場合は停止します。受け入れ条件 seed に1対1で対応できない条件や、存在しない requirement への参照は推測で補わず、機械可読な受け入れ条件から外して `openQuestions` に記録します。

主な RunStore 成果物は次のとおりです。

- `discussion/transcript.jsonl`、`discussion/conclusion.json`
- `approval.json`、`approval-history.json`
- `discuss-to-pr.json`
- `requirement.json`、`specification.json`
- `plan.json`、`implementation-result.json`、`verification.json`、`review.json`
- `steps/<stepId>.json`
- `publish-outcome.json`

Draft PR 本文には `Closes #<issue>` に加えて、保存済み `specification.json` の `## 受け入れ条件`、対象範囲、範囲外、残課題が含まれます。implementer と reviewer は既定で別プロファイルにし、同一プロファイルは明示設定がある場合だけ許可されます。
