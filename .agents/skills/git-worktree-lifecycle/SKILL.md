---
name: git-worktree-lifecycle
description: Meguribi の Git repository identity、branch、worktree、status、diff、commit、push、cleanup を安全に実装する際に使用する。
---

# Git worktree ライフサイクルスキル

## 使うタイミング

- repository identity の確認
- fetch、branch、worktree 作成
- status、diff、numstat
- explicit stage、commit、push
- resume 前の Git 状態確認
- cleanup

## 先に読む

- `docs/ja/architecture.md`
- `docs/ja/github-workflow.md`
- `docs/ja/security-and-operations.md`

## 基本原則

- 利用者の通常 checkout を変更しない。
- 1 implementation Issue に 1 branch、1 worktree を割り当てる。
- default branch を作業 branch にしない。
- `git -C <path>` または明示的な cwd を使う。
- shell 文字列連結を使わず、引数配列で実行する。
- destructive command は allowlist 方式で管理する。

## repository identity

次を照合してください。

- local repository root
- `origin` remote
- GitHub target `owner/repo`
- default branch
- base commit SHA

remote URL は HTTPS、SSH、`git@host:owner/repo.git` を正規化します。指定 target と remote が一致しない場合は自動補正せず停止してください。

## worktree 作成

1. 通常 checkout の dirty state を確認する。
2. remote と base branch を fetch する。
3. 同じ Issue の既存 branch / worktree / lock を確認する。
4. base SHA を記録する。
5. `agent/issue-<number>-<slug>` のような安定名を生成する。
6. Meguribi 管理ディレクトリ配下へ worktree を作成する。
7. 作成後の HEAD、branch、repository identity を再確認する。

## 差分管理

次を別々に取得します。

- tracked / untracked status
- changed filenames
- unified diff
- numstat
- binary file presence
- protected path changes

大きな diff を無条件でメモリへ読み込まず、上限超過時は停止できる設計にします。

## commit と push

- stage は対象ファイルを明示する。
- `git add -A` を既定にしない。
- secret scan と protected-path policy を通過してから commit する。
- commit message は Issue と変更内容を追跡できる短い文にする。
- push は作業 branch のみ。force push は禁止する。
- push 後に remote branch SHA を確認する。

## cleanup

cleanup 前に次を確認します。

- uncommitted changes
- untracked files
- branch の push 状態
- PR の存在と状態
- merge 状態
- active lock / process

不明な変更、未 push commit、open PR がある場合は、確認なしに削除しません。cleanup failure でも worktree path と復旧コマンドを残します。

## テスト

一時 Git repository で次を検証します。

- remote URL normalization
- base branch fetch
- branch / worktree creation
- duplicate Issue conflict
- dirty normal checkout
- status / diff / numstat
- explicit staging
- default branch protection
- push failure
- safe cleanup / cleanup refusal
- spaces and Unicode in paths

## 禁止事項

- `git reset --hard`
- `git clean -fdx`
- force push
- default branch への commit / push
- 利用者 checkout の branch 切り替え
- 未確認の worktree 強制削除

## 完了条件

- 利用者 checkout に副作用がない。
- 同じ Issue の二重実行を検出できる。
- 失敗時に worktree と復旧情報が残る。
- cleanup が未マージ変更を失わない。
