---
name: code-review
description: base branchとの差分をIssueの完了条件、設計、安全性、テスト、運用の観点でレビューし、Must-fixがなくなるまでpushまたはPR公開を止める。
---

# Code Review

## 目的

変更差分がIssueの目的を正しく満たし、Meguribiの安全境界とアーキテクチャを壊していないことを確認する。

## 入力

- 対象IssueとReadiness Gate成果物。
- Tech Leadの設計。
- `origin/main...HEAD`のdiffとlog。
- pre-push verification結果。
- QA結果。

## 手順

1. 比較baseと変更ファイルを確定する。
2. Issueの完了条件と差分を1対1で照合する。
3. 変更されていない依存先への影響を推論する。
4. 次の観点をすべて確認する。
5. 指摘をMust-fixとNice-to-haveへ分類する。
6. 修正後は差分と検証結果を再取得して再レビューする。

## レビュー観点

### 正しさ

- 正常系、異常系、境界値。
- 冪等性、再実行、partial failure。
- error codeとdomain errorの変換。
- schema validationと未知入力。

### アーキテクチャ

- CLIが薄いか。
- use caseがSDK/CLI固有形式へ依存していないか。
- adapterの責務が混ざっていないか。
- CodexとDevinが直接連携していないか。
- RunStoreとPolicyEngineの責務が漏れていないか。

### プロセスとGit

- shell injectionを起こす文字列連結がないか。
- cwd、timeout、signal、stdout/stderr、残留プロセス。
- default branchへの直接操作がないか。
- worktree外変更とcleanupの安全性。

### セキュリティ

- secret、token、`.env*`、credentialの扱い。
- prompt injectionと外部由来命令の隔離。
- 保護パスと危険操作の承認。
- ログ保存前のredaction。

### テスト

- 完了条件を直接証明しているか。
- fake adapter / fake executableを使っているか。
- timeout、cancel、failure、resumeの不足がないか。
- 実サービスを通常テストで呼んでいないか。

### 運用

- 利用者が次の操作を判断できるエラーか。
- RunStoreに復旧可能な証拠が残るか。
- 日英ドキュメントと識別子が同期しているか。

## 指摘分類

| 区分 | 定義 | 対応 |
|---|---|---|
| Must-fix | バグ、完了条件未達、安全性、データ破壊、必要テスト不足 | 修正後に再レビュー |
| Nice-to-have | 軽微な整理、命名、将来改善 | 今回必要なら修正、対象外ならフォローアップ候補 |

## 出力

```text
Code review
判定: PASS|FAIL
Must-fix:
- [file:line] 問題 / 影響 / 修正案
Nice-to-have:
確認済み観点:
要件充足:
検証結果:
残るリスク:
```

## PASS条件

- Must-fixが0件。
- 完了条件がすべて説明できる。
- pre-push verificationが成功または未実行理由が妥当。
- セキュリティ、保守性、テスト、副作用の各観点を確認済み。
- 残るリスクが明記されている。

## 停止条件

- Must-fixが残る間はPASSにしない。
- 同じ指摘で2回差し戻されたら`stuck-advisor`を使う。
- 合算3回を超えても収束しない場合はESCALATEする。
- レビュー中にコードを編集しない。
