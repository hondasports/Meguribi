---
name: delivery-workflow
description: Meguribi の `plan`、`run`、`review`、`resume`、`cleanup` コマンドと Issue から Draft PR までの状態遷移を実装する際に使用する。
---

# Delivery workflow スキル

## 使うタイミング

- `plan`、`run`、`review`、`resume`、`cleanup`
- 複数 adapter を束ねる use case
- workflow state transition
- Draft PR 作成までの一連処理

## 先に読む

- `docs/ja/product-and-workflow.md`
- `docs/ja/architecture.md`
- `docs/ja/github-workflow.md`
- `docs/ja/cli-and-integrations.md`
- `docs/ja/artifacts-and-schemas.md`

変更対象に応じて、GitHub、Git、RunStore、Codex、Devin、Verifier の各スキルも読んでください。

## 基本フロー

```text
Issue context
  -> approval / policy
  -> Codex plan
  -> worktree
  -> Devin implement
  -> deterministic verification
  -> Codex review
  -> policy gate
  -> commit / push
  -> Draft PR
  -> human review
```

各 step の入力と出力を RunStore に保存し、途中から再開できる形にします。

## `plan`

1. target repository / Issue を解決する。
2. Issue、コメント、label、repository rules を取得する。
3. input digest を保存する。
4. Codex を read-only で実行する。
5. `plan.json` を schema 検証する。
6. repository mutation がないことを確認する。
7. marker 付き Issue コメントを作成または更新する。

計画だけでは branch、worktree、PR を作成しません。

## `run`

1. approval と risk policy を確認する。
2. 同一 Issue の active run / PR / branch を確認する。
3. plan を再利用できるか digest で判定する。
4. branch / worktree を作成する。
5. Devin prompt を生成して実装する。
6. Git 差分と安全 policy を確認する。
7. Verifier を実行する。
8. Codex review を実行する。
9. publish policy を確認する。
10. 対象ファイルだけを stage、commit、push する。
11. Draft PR を検索または作成する。
12. Issue label / marker コメントを更新する。

失敗した step の後続処理は実行しません。

## `review`

- Issue、plan、現在の branch / PR diff、verification を再取得する。
- Codex review を新規または再実行する。
- review artifact と PR 要約を更新する。
- review 結果だけで Draft を解除・merge しない。

## `resume`

1. RunStore と lock を読み込む。
2. repository / Issue / base SHA / config / prompt version の digest を比較する。
3. worktree と child process の状態を確認する。
4. 再開可能な最後の安定 step を決める。
5. 変更がある場合は再計画、人間確認、停止のいずれかを選ぶ。

step を飛ばして成功状態へ変更してはいけません。

## `cleanup`

- active process がないことを確認する。
- uncommitted / untracked / unpushed changes を確認する。
- PR と merge 状態を確認する。
- 安全な場合だけ worktree を削除する。
- Run artifacts は履歴として残すか、明示的な retention policy に従う。

## 冪等性

再実行時に次を重複させません。

- marker 付き Issue comment
- branch
- worktree
- commit
- Draft PR

既存状態が期待と異なる場合は上書きせず停止します。

## 人間ゲート

最低限、次は人間判断を残します。

- high-risk implementation の開始
- protected path changes
- scope が Issue を超える場合
- Draft PR の merge
- Product loop の昇格判断

## テスト

workflow fixture で次を検証します。

- approved feature success
- missing approval
- low-risk bug
- plan reuse / invalidation
- Devin failure
- verification failure
- Codex changes required
- protected path block
- existing Draft PR update
- interruption and resume
- cleanup refusal
- duplicate run conflict

## 禁止事項

- step 間の暗黙状態
- 失敗後の自動 publish
- 自動 merge
- verification / review の省略
- digest 不一致のまま resume
- adapter の stdout を直接 workflow 判断に使うこと

## 完了条件

- 低リスク Issue から Draft PR まで一周できる。
- 各中間成果物を確認できる。
- 失敗時に worktree と復旧方法が残る。
- 再実行で GitHub と Git の成果物が増殖しない。
