# Meguribi AI エージェントスキル

このディレクトリは、Meguribi を実装する AI エージェント向けの実務手順を定義します。

## 基本ルール

1. すべての作業で、最初にルートの `AGENTS.md` を読む。
2. 共通ルールとして `meguribi-core` と `testing-and-quality` を参照する。
3. 変更対象に応じて、タスクの中心となる主スキルを1つ選ぶ。
4. その他の関連スキルは補助資料として読む。
5. スキル間で矛盾がある場合は、`AGENTS.md`、日本語ドキュメント、対象 Issue の順に優先する。
6. スキルに書かれていない大規模な設計変更を独断で行わない。

## Devinでの利用

Devin は `.agents/skills/<skill-name>/SKILL.md` を公式に自動検出します。

ただし、Devin が同時に有効化できるスキルは1つだけです。

- セッションでは、タスクの中心に対応する主スキルを1つ有効化する。
- 共通ルールはルートの `AGENTS.md` を正本とする。
- `meguribi-core`、`testing-and-quality`、その他の補助スキルは、通常のリポジトリファイルとして必要箇所を参照する。
- 明示的に有効化する場合は、Devinへの依頼に `@skills:<skill-name>` を含める。

例:

```text
Issue #123 を実装してください。@skills:delivery-workflow
```

Devin以外のエージェントが複数スキルを同時に扱える場合でも、主スキルと補助スキルの区別は維持してください。

## スキル一覧

| スキル | 主な用途 |
|---|---|
| `meguribi-core` | 全実装共通の設計原則と作業手順 |
| `typescript-cli-foundation` | TypeScript CLI、設定、診断、workspace 基盤 |
| `github-integration` | Issue、コメント、ラベル、Draft PR、CI 状態 |
| `git-worktree-lifecycle` | Git identity、branch、worktree、commit、push、cleanup |
| `run-store` | Run 状態、atomic write、lock、resume、ログ |
| `codex-integration` | Codex SDK、計画、レビュー、構造化出力 |
| `devin-integration` | Devin CLI、version driver、prompt、timeout、実装実行 |
| `verification-and-security` | 機械的検証、保護パス、risk、secret redaction |
| `delivery-workflow` | `plan`、`run`、`review`、`resume`、`cleanup` |
| `product-growth-loop` | 仮説、課題、要件、効果測定の成長ループ |
| `testing-and-quality` | Unit、Integration、fixture、品質確認 |

## 推奨する主スキル

### リポジトリ基盤

主スキル:

- `typescript-cli-foundation`

補助参照:

- `meguribi-core`
- `testing-and-quality`

### Issue から Draft PR まで

主スキル:

- `delivery-workflow`

補助参照:

- `meguribi-core`
- `github-integration`
- `git-worktree-lifecycle`
- `run-store`
- `codex-integration`
- `devin-integration`
- `verification-and-security`
- `testing-and-quality`

### プロダクト成長ループ

主スキル:

- `product-growth-loop`

補助参照:

- `meguribi-core`
- `github-integration`
- `testing-and-quality`

## スキルの更新

アーキテクチャ、コマンド、外部連携、成果物形式を変更した場合は、関連ドキュメントとスキルを同じ Pull Request で更新してください。