# Meguribi

> 仮説の火を、プロダクトへ巡らせる。  
> Carry the spark of a hypothesis through the product loop.

Meguribi is a personal, GitHub-centered product development orchestrator. It connects product discovery, GitHub Issues, Codex, ACP-based implementation agents such as Devin and Cursor, Git worktrees, automated verification, and pull requests without trying to become a large development platform.

Meguribi は、仮説・課題・要件・実装・検証・学習を GitHub 上でつなぐ、個人利用向けの軽量なプロダクト開発オーケストレーターです。大規模な管理基盤ではなく、既存リポジトリに対してローカル CLI から必要な処理だけを実行します。

## Documentation / ドキュメント

- [日本語ドキュメント](docs/ja/README.md)
- [English documentation](docs/en/README.md)

## Core loop / コアループ

```text
Observation
  -> Problem candidate
  -> Hypothesis
  -> Requirement
  -> Codex planning
  -> Agent implementation (Devin or Cursor)
  -> Verification and review
  -> Draft pull request
  -> Measurement
  -> Next hypothesis
```

The AI proposes and structures. A human approves product decisions and merges pull requests.

AI は候補の生成と構造化を担当し、プロダクト判断とマージは人間が担当します。

## Intended shape / 想定する形

```text
GitHub Issue
    |
    v
Meguribi CLI
    |-- Codex adapter: discovery, planning, review
    |-- Agent adapter: Devin or Cursor implementation through ACP
    |-- Git adapter: isolated worktree and branch
    |-- Verifier: lint, typecheck, tests, build
    `-- GitHub adapter: comments, labels, draft PR
```

## Design constraints / 設計上の制約

- Local-first CLI; no always-on server is required.
- GitHub Issues and pull requests are the source of truth.
- Each implementation task runs in an isolated Git worktree.
- Codex and implementation agents do not communicate directly; Meguribi passes structured artifacts between them.
- Human approval is required for product promotion, high-risk implementation, and merge.
- No database, web UI, queue, or multi-tenant architecture is required for the MVP.

## CLI status

The implemented CLI surface currently consists of `init`, `doctor`, `discover`, `hypothesis`, `promote`, `explore`, `require`, `plan`, `review`, `run`, `resume`, and `cleanup`. Discovery reads Issue evidence and optional Markdown/JSON observations, then saves candidates locally without creating Issues. Hypothesis structures explicit Issue sections, records missing evidence, and requires human approval. Promote turns a human-validated hypothesis into a Problem draft and only creates an Issue after explicit interactive confirmation. Explore compares multiple explicit solution directions without selecting a winner. Require turns an explicitly selected approved solution into an incomplete Requirement draft and records open questions instead of filling them in. The delivery wiring uses the selected ACP agent, the real GitHub, Git, Codex SDK, verifier, run store, and policy engine.

日本語: 現在利用できる CLI は `init`、`doctor`、`discover`、`hypothesis`、`promote`、`explore`、`require`、`plan`、`review`、`run`、`resume`、`cleanup` です。標準設定では、選択した ACP エージェント、実 GitHub / Git アダプター、Codex SDK、検証コマンド、ローカル RunStore、PolicyEngine を使用します。fixture 用の fake は `MEGURIBI_DELIVERY_FAKES=1` を明示した場合だけ有効になります。GitHub を使わないローカル検証では、`run` に `--local --repo-path <path>` を指定できます。

```bash
meguribi init --implementer cursor
meguribi doctor --implementer cursor
meguribi discover owner/repo --since 30d --limit 5
meguribi run owner/repo#125 --implementer devin
meguribi resume owner/repo#125
```

All product-loop commands in the current roadmap are implemented:

```bash
meguribi measure owner/repo#125 --period 14d
```

### `meguribi discover owner/repo`

English: Extracts candidate problems from existing Issues, specified documents, and optional usage data. Candidates are saved locally by default; Issues are not created automatically.

日本語: 既存 Issue、指定した資料、任意の利用データから課題候補を抽出します。既定では候補をローカルに保存し、Issue を自動作成しません。`--since` と `--limit` で対象期間と候補数を指定できます。

### `meguribi promote owner/repo#123`

English: Turns a `product:validated` Hypothesis Issue into a solution-neutral Problem draft. `--create-issue` requires interactive human confirmation before creating a new Issue.

日本語: `product:validated` の Hypothesis Issue から、解決策を固定しない Problem 草案を作成します。`--create-issue` を指定した場合も、対話的な人間確認なしに新規 Issue は作成しません。

### `meguribi explore owner/repo#124`

English: Compares multiple explicit solution directions across value, cost, risk, reversibility, and measurement dimensions without choosing a winner.

日本語: 複数の明示された解決方針を、価値・コスト・リスク・可逆性・測定難易度などで比較します。採用案は自動選択しません。

### `meguribi require owner/repo#124`

English: Converts a `product:approved` solution into an incomplete Requirement / Feature Issue draft. Use `--solution <number>` to select the solution; unresolved details are recorded in `openQuestions`.

日本語: `product:approved` の解決方針を、不足情報を `openQuestions` に残した Requirement / Feature Issue の草案へ変換します。昇格する解決方針は `--solution <number>` で選択します。

### `meguribi plan owner/repo#125`

English: Asks Codex to read the target repository and produce a technical implementation plan. Planning is read-only and does not modify code.

日本語: Codex が対象リポジトリを読み取り、技術的な実装計画を作成します。計画作成は読み取り専用で、コードを変更しません。

### `meguribi review owner/repo#125`

English: Asks Codex to review the diff for an existing pull request or the branch associated with an Issue, including requirement coverage, risks, and required changes.

日本語: 既存 Pull Request、または Issue に紐づくブランチの差分を Codex にレビューさせます。要件の充足状況、リスク、必要な変更を確認します。

### `meguribi measure owner/repo#125`

English: Creates a human-reviewed Measurement draft from a merged pull request linked in a Requirement / Feature Issue. Use `--period <duration>` to define the measurement period; missing evidence remains in `openQuestions`.

日本語: Requirement / Feature Issue の delivery summary からマージ済み Pull Request を復元し、Measurement 草案を作成します。測定期間は `--period <期間>` で指定し、未提示の根拠は `openQuestions` に残します。結果判定は人間が行います。

### `meguribi cleanup owner/repo#125`

English: Cleans up the worktree and temporary information for a completed run. It never deletes unmerged changes or unsaved work.

日本語: 完了した Run の worktree と一時情報を整理します。未マージの変更や未保存の作業は削除しません。

The MVP intentionally starts with a smaller subset. See the implementation roadmap in each language.

## Status

The core adapters, ACP sessions, agent diagnostics, artifact persistence, process shutdown, and delivery workflow are under active implementation. See the implementation roadmap for the current boundary and remaining work.

## License

[MIT](LICENSE)
