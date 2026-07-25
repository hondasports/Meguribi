---
name: run-store
description: Meguribi の実行状態、成果物、ログ、atomic write、lock、resume を実装する際に使用する。
---

# RunStore スキル

## 使うタイミング

- Run ID と保存先の設計
- `state.json` と成果物保存
- lock と同一 Issue の排他制御
- 中断後の `resume`
- stdout / stderr / event log の保存

## 先に読む

- `docs/ja/artifacts-and-schemas.md`
- `docs/ja/security-and-operations.md`
- `docs/ja/cli-and-integrations.md`

## 保存方針

- XDG Base Directory に従う。
- 対象リポジトリへ実行ログを commit しない。
- Run ごとに独立ディレクトリを作る。
- JSON は schema version を持つ。
- 更新は一時ファイル作成と rename による atomic write を基本とする。
- 機密情報を除外した内容だけを保存する。

## 推奨構成

```text
runs/<owner>/<repo>/issue-<number>/<run-id>/
  state.json
  input-digest.json
  issue.json
  plan.json
  devin-prompt.md
  agent-events.jsonl
  verification.json
  review.json
  diff.patch
  logs/
```

## 状態モデル

状態は明示的な型と遷移関数で管理します。

```text
created -> planning -> planned -> implementing -> verifying
-> reviewing -> publishing -> awaiting_human
```

失敗・中断は `blocked`、`failed`、`cancelled`、`interrupted` として保持します。不正な遷移では、現在状態と許可される次操作を返します。

## lock

lock には repository、Issue、run ID、process、host、作成時刻、更新時刻を保存します。

stale 判定は一つの値だけに依存せず、更新時刻、worktree、子 process、最後の状態を組み合わせます。不明な場合は自動解除せず停止します。

## resume 前の確認

少なくとも次を比較します。

- Issue 本文と関連コメント
- labels と承認状態
- base branch と base SHA
- `.meguribi.yml`
- prompt / schema version
- working tree state

変更がある場合は、再計画、確認、停止のいずれかを選びます。

## ログ

- stdout と stderr を分離する。
- timestamp、command ID、exit code、duration を持つ。
- 保存前に機密情報を除外する。
- size limit と truncation marker を設ける。
- 利用者向け要約と診断ログを分ける。

## テスト

- Run ID uniqueness
- XDG path resolution
- atomic write interruption
- corrupted JSON recovery
- lock conflict / stale lock
- resume digest mismatch
- redaction
- large log truncation
- unknown schema version

## 禁止事項

- 機密情報を保存すること
- state file を部分書き込みすること
- 判定が曖昧な lock を自動削除すること
- schema version なしで互換性を仮定すること

## 完了条件

- process interruption 後も state が読み取れる。
- 同一 Issue の二重実行を防止できる。
- resume 前に入力と Git 状態を検証できる。
- 保存内容から実行経路を追跡できる。
