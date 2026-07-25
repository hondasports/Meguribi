---
name: verify-pre-push
description: 変更内容に応じたlint、typecheck、test、build、追加の統合検証を実行し、証拠付きでpush可否を判定する。
---

# Push前検証

## 目的

AIの自己申告ではなく、Meguribiリポジトリ自身のコマンドとGit差分を使って、pushしてよい状態かを判定する。

## 前提

- Issue Readiness GateがGo。
- 実装と必要テストが完了している。
- 対象ブランチまたはworktreeがdefault branchではない。
- 比較baseが確定している。通常は`origin/main`。

## 差分確認

```bash
git fetch origin main
git diff --name-only origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
```

想定外のdirty state、worktree外変更、保護パス変更があれば停止する。

## 基本検証

リポジトリに定義されたスクリプトを使用する。標準は次のとおり。

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

並列実行はログ分離と終了コード集約を正しく実装できる場合だけ許可する。単純さを優先して逐次実行してよい。

## 変更別の追加確認

### `packages/adapters/**`

- fake executable / fake clientを使うIntegration test。
- timeout、cancel、stderr、non-zero exit。
- SDK/CLIの生出力が境界で検証されること。

### Git / worktree関連

- 一時Gitリポジトリでworktree作成・status・diff・cleanupを確認する。
- default branchへcommit/pushしないこと。
- cleanupが未保存変更を削除しないこと。

### RunStore / state関連

- atomic write、lock、stale lock、digest、resume不一致を確認する。
- secret redactionとログ出力を確認する。

### CLI / config関連

- `--help`、`--version`、invalid argument、invalid config。
- Node.js LTS major、依存CLI、認証診断。

### ドキュメントのみ

- リンク、パス、識別子、日英同期を確認する。
- 実行コードがない場合はテスト未実行理由をPRへ記載する。

## 記録形式

```text
Pre-push verification
Base:
Changed files:
- lint: PASS|FAIL|NOT_RUN
- typecheck: PASS|FAIL|NOT_RUN
- test: PASS|FAIL|NOT_RUN
- build: PASS|FAIL|NOT_RUN
- additional checks:
Protected paths:
Secret scan:
Push decision: ALLOW|BLOCK
```

## 判定

- 1つでも失敗したら`BLOCK`。
- 未実行項目は成功扱いにせず、理由と影響を記録する。
- 保護パスまたはsecret疑いがあれば、人間承認の有無にかかわらず差分を再確認する。
- workflowやテストを弱めて成功させない。

## 停止条件

- 基本検証未実行でpushしようとしている。
- 失敗を既知のflakyとして根拠なく無視している。
- ログにsecretが含まれる。
- base branchまたは対象リポジトリが曖昧。
- 同じ失敗を2回繰り返した。`stuck-advisor`へ移る。

## 完了条件

- 必要な検証が成功した。
- 実行コマンド、終了コード、未実行理由が記録されている。
- Git差分と保護パスを確認した。
- `code-review`へ渡せる状態になっている。
