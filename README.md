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

The implemented delivery surface currently consists of `doctor`, `run`, and `resume`. The default delivery wiring uses the selected ACP agent, the real local run store and policy engine, and temporary fakes for GitHub and Git until those adapters are completed.

```bash
meguribi doctor --implementer cursor
meguribi run owner/repo#125 --implementer devin
meguribi resume owner/repo#125
```

The following commands are specified but not yet implemented:

```bash
meguribi discover owner/repo
meguribi hypothesis owner/repo#123
meguribi promote owner/repo#123
meguribi require owner/repo#124
meguribi plan owner/repo#125
meguribi run owner/repo#125
meguribi review owner/repo#125
meguribi measure owner/repo#125
meguribi cleanup owner/repo#125
```

The MVP intentionally starts with a smaller subset. See the implementation roadmap in each language.

## Status

The core adapters, ACP sessions, agent diagnostics, artifact persistence, process shutdown, and delivery workflow are under active implementation. See the implementation roadmap for the current boundary and remaining work.

## License

[MIT](LICENSE)
