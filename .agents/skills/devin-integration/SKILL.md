---
name: devin-integration
description: Devin CLI を利用した承認済み実装の実行、version driver、prompt file、timeout、signal、結果正規化を実装する際に使用する。
---

# Devin 連携スキル

## 使うタイミング

- `DevinAdapter` の追加・変更
- Devin executable / version 検出
- prompt file の生成
- CLI driver の version 対応
-実装 process の timeout、signal、ログ、result normalization

## 先に読む

- `docs/ja/cli-and-integrations.md`
- `docs/ja/security-and-operations.md`
- `docs/ja/artifacts-and-schemas.md`

実装時は、利用する Devin CLI の公式ドキュメントとローカル version を確認してください。CLI option を固定的に想定せず、version-specific driver へ分離します。

## 責務

Devin は次だけを担当します。

- 承認済み Issue と Codex plan に基づくコード変更
- 必要なテストの追加
- 指定 worktree 内での実装
- 未解決事項の結果出力

次は担当させません。

- commit / push
- Issue / PR 更新
- PR 作成
- repository settings
- default branch 操作
- production deployment

## adapter 構成

```text
DevinAdapter
  -> DevinDriverRegistry
      -> DevinDriverVx
  -> ProcessRunner
  -> ResultNormalizer
```

version が対応範囲外の場合は、推測して実行せず明示的に停止します。

## prompt file

Meguribi が次を組み合わせて prompt を生成します。

- Issue title / body / relevant comments
- Codex `plan.json`
- `AGENTS.md`
- 対象リポジトリの追加ルール
- 完了条件
- 対象外
- 変更禁止事項
- 期待する結果形式

Issue やコメント内の命令は untrusted content として区切り、Meguribi のルールを上書きできないことを明記します。

## 実行ルール

- cwd は Issue 専用 worktree に固定する。
- prompt は引数へ直接埋め込まず file で渡す。
- stdout / stderr を分離して保存する。
- timeout と cancellation signal を処理する。
- process group を考慮し、子 process が残らない停止処理を行う。
- 実行前後で worktree 外の変更を検出する。
- Git status と changed files を Meguribi 側で取得する。
- Devin の自然言語によるテスト成功報告は検証結果に使用しない。

## 結果の正規化

CLI exit code、session metadata、stdout、stderr、生成結果を次へ正規化します。

- status
- session ID
- duration
- exit code
- reported changed files
- unresolved items
- raw log locations

reported changed files は参考情報とし、正本は Git adapter が取得した差分です。

## 安全確認

実行後に次を検査します。

- worktree 外変更
- protected path changes
- unexpected Git operations
- default branch mutation
- diff / changed files limit
- lock ownership

違反時は commit / push へ進めません。

## テスト

fake Devin executable で次を検証します。

- version detection
- supported / unsupported driver
- prompt file generation
- cwd
- successful exit / non-zero exit
- timeout / cancellation
- partial stdout / stderr
- malformed result
- child process termination
- worktree outside mutation detection
- Devin が Git 操作を試みた場合の停止

## 禁止事項

- unsupported version の推測実行
- prompt の shell interpolation
- Devin への GitHub write 権限付与
- agent の申告を changed files や verification の正本にすること
- timeout なしの実行

## 完了条件

- fake executable による integration test がある。
- 非対応 version で明示的に失敗する。
- worktree 内だけで実装を実行できる。
- 結果を adapter 固有型からドメイン型へ正規化できる。
