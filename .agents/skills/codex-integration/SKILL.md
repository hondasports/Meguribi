---
name: codex-integration
description: Codex SDK を利用したリポジトリ調査、実装計画、差分レビュー、構造化出力を実装する際に使用する。
---

# Codex 連携スキル

## 使うタイミング

- `CodexAdapter` の追加・変更
- `plan.json` の生成
- `review.json` の生成
- thread ID、event log、schema repair
- Codex prompt と output schema の変更

## 先に読む

- `docs/ja/cli-and-integrations.md`
- `docs/ja/artifacts-and-schemas.md`
- `docs/ja/security-and-operations.md`

実装時は、利用する Codex SDK の公式ドキュメントとインストール済み version を確認してください。記憶した API を前提にせず、version 差異を adapter 内へ閉じ込めます。

## 責務

Codex は次を担当します。

- Issue とコードの調査
- 変更候補と実装手順の構造化
- リスク、対象外、必要テストの指摘
- diff と検証結果のレビュー
- 要件充足、scope violation、severity の判定

Codex に実装ファイルを変更させません。

## adapter 境界

コアから渡す入力例:

```ts
interface PlanningRequest {
  repositoryPath: string;
  issue: IssueContext;
  repositoryRules: string;
  productContext?: string;
}
```

コアへ返す結果は SDK 固有型ではなく、検証済みの `PlanArtifact` / `ReviewArtifact` とします。

## 実行ルール

- working directory を Issue 専用 worktree に固定する。
- planning と review は read-only にする。
- network access は必要性が明示されない限り無効にする。
- approval policy は自動実行に適した非対話設定へ固定する。
- thread は role 単位で分ける。
- 同じ成果物の修正だけ、対応する thread を resume する。
- thread ID と event log を RunStore に保存する。
- timeout と cancellation signal を伝播する。

## 構造化出力

- JSON Schema と Zod の双方で検証する。
- schema version を成果物へ入れる。
- 不正 JSON を成功扱いしない。
- repair は最大1回など、明示的な上限を持つ。
- repair prompt へ validation error だけを渡し、要求を広げない。
- unknown severity や status は拒否する。

## planning の必須項目

- 要求の要約
- 完了条件
- 対象外
- 変更候補
- 実装手順
- リスク
- 必要テスト
- 人間確認が必要な判断

## review の必須項目

- `approved` または `changes_required`
- 要件ごとの coverage
- severity 付き findings
- scope violation
- verification result の扱い
- 人間向け PR 要約

Codex review だけで PR を merge 可能にしてはいけません。

## 変更検出

Codex 実行前後で Git status と diff を比較し、read-only のはずの実行で変更があれば失敗として停止します。

## テスト

- fake Codex client
- valid / invalid structured output
- schema repair success / failure
- timeout / cancellation
- empty final response
- event stream interruption
- thread resume
- planning 時の repository mutation detection
- review severity normalization

## 禁止事項

- SDK 型を core へ公開すること
- schema 未検証の結果を保存すること
- repair の無限反復
- planning / review でのファイル変更
- review 結果による自動 merge

## 完了条件

- fixture repository から有効な `plan.json` を生成できる。
- diff と verification から有効な `review.json` を生成できる。
- 不正出力と repository mutation を検出して停止できる。
