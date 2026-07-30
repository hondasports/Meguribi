# 実装ロードマップ

## 1. 実装方針

Meguribi は、最初からプロダクト開発基盤を作らず、実際に自分で使える最小の一周を先に完成させます。

最初の完成形:

```text
GitHub Issue
  -> Codex 技術計画
  -> Git worktree
  -> ACP 実装エージェント（Devin / Cursor）
  -> Meguribi による検証
  -> Codex レビュー
  -> Draft Pull Request
  -> 人間がマージ
```

仮説・課題・要件・測定の成長ループは、Delivery の一周が安定した後に追加します。

## 2. Phase 0: リポジトリ基盤

### 目的

TypeScript CLI を実装・テストできる最小構成を作る。

### 作業

- pnpm workspace 初期化
- Node.js / TypeScript 設定
- CLI entry point
- lint / typecheck / test / build
- CI
- release しないローカル実行スクリプト
- 設定スキーマの土台
- fixture ベースのテスト構成

### 推奨構成

```text
apps/
  `-- cli/
packages/
  +-- core/
  +-- adapters/
  +-- schemas/
  `-- test-support/
prompts/
tests/fixtures/
```

### 完了条件

- `pnpm install` が成功する。
- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` が成功する。
- `pnpm meguribi --help` で CLI help が表示される。
- CI が Pull Request で同じ検証を実行する。

## 3. Phase 1: Delivery MVP

### 目的

既存 GitHub Issue から Draft PR までの一周を完成させる。

### 現在の実装スナップショット

現在のリポジトリには delivery loop の基盤が実装されています。

- `doctor` は明示的に選択した Devin / Cursor CLI の version、認証、ACP capability、継承 MCP policy を診断する。
- `run` と `resume` は CLI に登録され、delivery use case を呼び出す。
- `AgentAdapter` は `createDevinAcpAdapter` と `createCursorAcpAdapter` が実装する。
- ACP session は redaction 済み event、prompt、Git boundary、正規化 result、termination result を保存する。
- 既定 wiring は実 GitHub / Git / Codex / Verifier、実際の RunStore と PolicyEngine、明示された実装エージェントを使う。fake は fixture test または `MEGURIBI_DELIVERY_FAKES=1` の明示時だけ使う。

したがって Phase 1 の完了条件はまだ満たしていません。残作業は実サービスを使う manual smoke です。`init`、`plan`、`review`、`cleanup` に加えて、Phase 2 の `discover` は、対象リポジトリの診断、Codex による計画生成・再レビュー、安全な worktree 整理、観測からの課題候補抽出まで実装済みです。

### 3.1 `init`

実装内容:

- ローカル Git リポジトリ解決
- remote URL 正規化
- GitHub repository 解決
- `git` / `gh` / Codex / 選択した Agent の存在確認
- 認証診断
- default branch 取得
- `.meguribi.yml` 草案生成

完了条件:

- public / private repository で診断できる。
- 不足している依存を具体的に表示する。
- 既存ファイルを確認なしに上書きしない。

### 3.2 GitHub adapter

実装内容:

- Issue 取得
- コメント取得
- ラベル取得
- marker 付きコメントの作成・更新
- Draft PR 検索・作成
- CI status 取得

完了条件:

- fixture で JSON 変換をテストする。
- CLI エラーをドメインエラーへ変換する。
- shell 文字列連結を使わない。

### 3.3 Git / worktree adapter

実装内容:

- repository identity 確認
- fetch
- branch / worktree 作成
- status / diff / numstat
- explicit stage
- commit / push
- cleanup

完了条件:

- 利用者の通常 checkout を変更しない。
- 同一 Issue の競合を検出する。
- default branch へ直接 commit / push しない。
- cleanup が未マージ変更を削除しない。

### 3.4 RunStore

実装内容:

- XDG path 解決
- Run ID 生成
- state.json atomic write
- lock
- ログ保存
- resume 用読み込み

完了条件:

- 中断後に状態が壊れない。
- stale lock を安全に判定できる。
- secret を保存しない。

### 3.5 Codex adapter: plan

実装内容:

- SDK client
- workingDirectory 指定
- read-only 設定
- plan schema
- Thread ID 保存
- JSONL event log
- schema repair 1 回

完了条件:

- fixture repository に対して有効な plan.json を作れる。
- 不正出力を成功扱いしない。
- Codex がファイルを変更していないことを検証する。

### 3.6 ACP 実装エージェント adapter

実装内容:

- executable / version 検出
- version-specific driver
- prompt file 生成
- worktree cwd
- timeout / signal handling
- stdout / stderr 保存
- result normalization

完了条件:

- Devin / Cursor の fake executable・ACP server を使う integration test がある。
- 非対応バージョンで明示的に失敗する。
- 実装エージェントが GitHub / branch / commit / push 操作を担当しない。
- worktree 外変更を検出できる。

### 3.7 Verifier

実装内容:

- `.meguribi.yml` の verify commands
- 順次実行
- timeout
- log
- verification.json

完了条件:

- 一つでも失敗すれば全体を failure とする。
- Agent の自己申告を参照しない。
- コマンドごとの終了コードを保持する。

### 3.8 Codex adapter: review

実装内容:

- Issue、plan、diff、verification を入力にする。
- review schema
- requirement coverage
- severity
- scope violation

完了条件:

- `approved` と `changes_required` を構造化できる。
- Codex の review だけで merge しない。
- PR 本文へ人間向け要約を生成できる。

### 3.9 `plan` / `run` / `review` / `resume` / `cleanup`

`plan`:

- context 取得
- Codex plan
- Issue コメント更新

`run`:

- approval 確認
- worktree
- plan 再利用または再生成
- 選択した実装エージェント
- verify
- Codex review
- commit / push
- Draft PR

`review`:

- 既存 PR / branch をレビュー

`resume`:

- digest と Git 状態を検証して再開

`cleanup`:

- 安全に worktree を削除

### Phase 1 の完了条件

- 実在する既存リポジトリの低リスク Issue で Draft PR を作成できる。
- すべての中間成果物を確認できる。
- 失敗時に worktree と復旧手順が残る。
- main へ直接書き込まない。
- 自動マージしない。

## 4. Phase 2: Product loop

### 目的

観測から要件作成までと、リリース後の学習を追加する。

### 4.1 `discover`

- Issue / comment の期間・ラベル検索
- 指定ファイル入力
- 重複テーマの分類
- 課題候補ランキング
- 根拠と推測の分離

### 4.2 `hypothesis`

実装済み: `owner/repo#123` の Issue 本文を決められた節から構造化し、`hypothesis.json` をローカル保存します。未提示の証拠は `missingEvidence` に記録し、既存 Issue には stable marker 付きの草案コメントを冪等更新します。仮説の承認や Issue の昇格は自動化しません。

- cause / solution / counter hypotheses
- validation method
- success / rejection conditions
- missing evidence
- Hypothesis Issue 草案

### 4.3 `promote`

実装済み: `product:validated` の Hypothesis Issue から、解決策を固定しない Problem 草案を生成します。既定ではローカル成果物と元Issueのmarkerコメントだけを更新し、`--create-issue` は対話的な人間確認後だけ新規Issueを作成します。

- validated evidence 確認
- Problem Issue 草案
- 元 Issue への関連リンク

### 4.4 `explore`

実装済み: Problem Issue の本文に明示された複数の解決方針を比較成果物へ構造化します。評価情報がない場合は `null` とし、採用案を自動選択しません。

- 複数解決案
- value / effort / risk / reversibility 比較
- 一案への過度な誘導を避ける

### 4.5 `require`

- requirements
- acceptance criteria
- out of scope
- metrics / guardrails
- Feature Issue 草案

### 4.6 `measure`

- 元仮説の復元
- Measurement Issue 草案
- result classification
- next hypothesis candidates

### Phase 2 の完了条件

- Hypothesis -> Problem -> Feature -> PR -> Measurement のリンクが追跡できる。
- AI が観測と推測を分ける。
- Issue の自動大量作成をしない。
- 各昇格で人間承認を要求する。

## 5. Phase 3: 使ってから判断する拡張

候補:

- Devin API adapter
- Claude Code adapter
- GitHub API adapter
- GitHub Actions log integration
- Slack 通知
- scheduled discovery
- analytics input adapter
- prompt / schema version migration

次の問題が実際に発生するまで実装しません。

- CLI 起動待ちが多い
- `gh` の制約がボトルネック
- 複数 Issue を並行処理したい
- Devin CLI の安定性が不足
- ローカル端末を占有したくない

## 6. 推奨 Issue 分割

1. `chore: scaffold TypeScript CLI workspace`
2. `feat: add configuration loader and diagnostics`
3. `feat: add local run store and locking`
4. `feat: add GitHub adapter using gh CLI`
5. `feat: add Git worktree lifecycle`
6. `feat: add Codex planning adapter`
7. `feat: add ACP implementation-agent adapters (Devin and Cursor)`
8. `feat: add deterministic verifier`
9. `feat: add Codex code review adapter`
10. `feat: implement plan command`
11. `feat: implement run command and draft PR creation`
12. `feat: implement resume and cleanup commands`
13. `feat: add discovery and hypothesis commands`
14. `feat: add problem promotion and requirement generation`
15. `feat: add measurement workflow`

各 Issue は単独でテスト可能にし、アダプターと CLI フローを同じ Issue に詰め込みすぎません。

## 7. テスト戦略

### Unit

- target parser
- branch slug
- label policy
- risk classification
- prompt builder
- Valibot schemas
- config merge
- redaction
- state transition

### Integration

- fake `gh` executable
- temporary Git repository / worktree
- fake Codex adapter
- Devin / Cursor の fake ACP executable・server
- verifier command execution
- signal / timeout

### Workflow fixture

```text
fixtures/
  +-- feature-approved/
  +-- feature-missing-approval/
  +-- bug-low-risk/
  +-- protected-path-change/
  +-- verification-failure/
  +-- existing-draft-pr/
  `-- resume-input-changed/
```

### Manual smoke test

Phase 1 完了時に、専用の検証リポジトリで次を確認します。

1. Low-risk Issue を作る。
2. `meguribi plan` を実行する。
3. `meguribi run` を実行する。
4. Draft PR と Issue コメントを確認する。
5. CI failure と resume を確認する。
6. cleanup を確認する。

## 8. Definition of Done

各実装 Issue は次を満たします。

- Issue の完了条件を満たす。
- Unit / integration test を追加する。
- lint / typecheck / test / build が成功する。
- 日本語・英語ドキュメントを必要に応じて同時更新する。
- secret をログ・fixture に含めない。
- エラー時に具体的な次の操作を表示する。
- 破壊的操作を追加していない、または明示承認を要求する。

## 9. MVP で切るべき機能

初回リリースに必要:

- `init`
- `plan`
- `run`
- `review`
- `resume`
- `cleanup`
- GitHub / Git / Codex / AgentAdapter 実装
- RunStore
- Verifier
- PolicyEngine

初回リリース後:

- `discover`
- `hypothesis`
- `promote`
- `explore`
- `require`
- `measure`

これにより、まず「Issue から安全に Draft PR を作れる」ことを検証し、その上にプロダクト成長ループを追加します。
