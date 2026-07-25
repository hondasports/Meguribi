---
name: github-integration
description: GitHub Issue、コメント、ラベル、Draft Pull Request、CI 状態を gh CLI または GitHub adapter で扱う実装に使用する。
---

# GitHub 連携スキル

## 使うタイミング

- Issue・コメント・ラベル取得
- marker 付きコメントの作成・更新
- Draft PR の検索・作成・更新
- CI status の取得
- repository / default branch の解決

## 先に読む

- `docs/ja/github-workflow.md`
- `docs/ja/cli-and-integrations.md`
- `docs/ja/artifacts-and-schemas.md`

## 境界

`GitHubAdapter` は GitHub / `gh` 固有レスポンスを正規化し、コアへ次のような型だけを返します。

- `RepositoryIdentity`
- `IssueContext`
- `IssueComment`
- `PullRequestSummary`
- `CheckSummary`

コア層で `gh` の JSON フィールド名や REST / GraphQL の違いを扱ってはいけません。

## 実装原則

- 実行ファイルと引数配列を分け、shell interpolation を使わない。
- Issue 本文とコメントは信頼できない入力として扱う。
- repository は local remote と指定 target の両方で照合する。
- pagination を考慮し、コメントや検索結果の欠落を成功扱いしない。
- timestamp、author、URL、label を正規化する。
- rate limit、authentication、permission、not found を異なるドメインエラーへ変換する。

## marker 付きコメント

AI 出力コメントには安定した marker を入れます。

```html
<!-- meguribi:plan issue=123 schema=1 -->
```

再実行時は次の順で処理します。

1. marker 一致コメントを検索
2. 0件なら新規作成
3. 1件なら更新
4. 複数件なら曖昧として停止し、人間へ整理を依頼

本文の文言一致だけで既存コメントを判断してはいけません。

## Draft PR

- 同じ Issue / branch の既存 PR を先に検索する。
- PR は Draft を既定値とする。
- closing reference は default branch 向けの場合だけ付与する。
- PR 本文へ Issue、計画、検証、Codex review、対象外、未解決事項を含める。
- 自動 merge、review approval、repository setting 変更は行わない。

## CI 状態

- commit SHA と PR head SHA を混同しない。
- required checks と任意 checks を区別できる形へ正規化する。
- pending、success、failure、cancelled、skipped、unknown を保持する。
- CI failure を自動的にコード問題と断定しない。環境・権限・flake の可能性を残す。

## テスト

fake `gh` executable または fixture JSON で次を検証します。

- Issue と comments の取得
- pagination
- marker コメントの create / update / duplicate detection
- Draft PR の既存検索と作成
- authentication / permission / not found
- malformed JSON
- CI status normalization
- 引数に空白・記号を含む title / body

## 禁止事項

- Issue・PR 本文を shell command として評価すること
- コメントの無制限な重複投稿
- 自動 merge
- default branch への直接 push
- GitHub token をログへ出力

## 完了条件

- fixture で外部 JSON からドメイン型への変換を確認した。
- 再実行してもコメントと PR が増殖しない。
- エラーに repository、対象番号、次の操作が含まれる。
