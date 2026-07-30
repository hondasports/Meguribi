# Meguribi 日本語ドキュメント

Meguribi は、既存の GitHub リポジトリに対して、仮説から Pull Request、効果測定までをつなぐ個人向け CLI です。

大規模な開発プラットフォームを目指さず、GitHub Issue、Git worktree、Codex、ACP ベースの実装エージェント（Devin / Cursor）、既存 CI を薄く連携させます。

## 推奨する読み順

1. [プロダクト構想と成長ループ](product-and-workflow.md)
2. [システムアーキテクチャ](architecture.md)
3. [GitHub 運用モデル](github-workflow.md)
4. [CLI と外部連携仕様](cli-and-integrations.md)
5. [成果物・状態・スキーマ](artifacts-and-schemas.md)
6. [安全設計と運用](security-and-operations.md)
7. [実装ロードマップ](implementation-roadmap.md)
8. [設計判断記録](decisions/)

## ドキュメントの役割

| ドキュメント | 主な対象 | 決めること |
|---|---|---|
| プロダクト構想と成長ループ | Product / BIZ / 開発者 | 何を解決し、どこに人間判断を置くか |
| システムアーキテクチャ | 実装者 | コンポーネント、依存方向、処理シーケンス |
| GitHub 運用モデル | 利用者 / 実装者 | Issue、ラベル、ブランチ、PR の扱い |
| CLI と外部連携仕様 | 実装者 | コマンド、設定、Codex・実装エージェント接続 |
| 成果物・状態・スキーマ | 実装者 | ローカル保存形式と構造化出力 |
| 安全設計と運用 | 利用者 / 実装者 | 権限、禁止操作、再実行、障害対応 |
| 実装ロードマップ | 実装者 | MVP の順序、Issue 分割、完了条件 |
| 設計判断記録 | 実装者 | PoC結果を踏まえた採用・不採用判断と再検討条件 |

## 現在の実装範囲

実装済みの CLI は `init`、`doctor`、`discover`、`hypothesis`、`promote`、`plan`、`review`、`run`、`resume`、`cleanup` です。`discover` は Issue と指定資料から観測と課題候補を抽出してローカル保存し、Issueを自動作成しません。`hypothesis` は Issue 本文の明示された節を仮説成果物へ構造化し、不足情報を記録して人間承認を要求します。`promote` は `product:validated` の仮説から Problem 草案を作り、明示的な確認なしに新規 Issue を作成しません。`plan` / `review` は Codex の計画・再レビューを、`run` と `resume` は delivery workflow を、`cleanup` は安全な worktree 整理を担当します。`explore`、`require`、`measure` は、現時点では仕様・土台の段階です。

## 主要な設計判断

- [ADR 0001: Devin 実装 transport に ACP を採用する](decisions/0001-adopt-devin-acp.md)

## 設計上の優先順位

1. 既存リポジトリを壊さない。
2. Issue の意図と実装差分を追跡できる。
3. AI の判断と人間の判断を分離する。
4. AI の自己申告ではなく、実コマンドで検証する。
5. ローカルで理解・修正できる小ささを維持する。
6. 便利さより停止可能性と再現性を優先する。

## 正本

日本語版はプロダクト意図の正本です。英語版と仕様がずれた場合は、日本語版を確認したうえで両方を同時に修正します。
