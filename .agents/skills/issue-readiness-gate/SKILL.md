---
name: issue-readiness-gate
description: Issueの価値、最小スコープ、技術設計、検証方法、依存関係を複数ロールで確認し、実装開始可否を判定する。Go判定まではコード編集を行わない。
---

# Issue Readiness Gate

## 目的

Issue本文だけを根拠に実装へ進まず、Product Lead、Tech Lead、QA Agentの観点を統合して、実装可能な状態かを判定する。

## 使うタイミング

- 新機能、振る舞い変更、アーキテクチャ変更を実装する前。
- Codexへ実装計画を依頼する前。
- Devinへコード変更を依頼する前。
- Issueの完了条件や依存関係に曖昧さがある場合。

## モード

### `full`

新機能、プロダクト判断、複数境界をまたぐ変更で使用する。

- Product Lead
- Tech Lead
- QA Agent

### `light`

次をすべて満たす低リスク変更で使用できる。

- 完了条件が具体的。
- 認証、secret、削除、課金、本番、GitHub Actionsを変更しない。
- スキーマ互換性やデータ移行がない。
- 単一コンポーネントまたは単一アダプター内に収まる。
- 依存Issueのブロッカーがない。

lightではTech LeadとQA Agentを確認する。

## 手順

1. `prompt-injection-guard`を使ってIssueとコメントを読む。
2. 関連する日本語ドキュメントと依存Issueだけを読む。
3. Issueを次へ分解する。
   - 解く課題
   - 実装範囲
   - 今回やらないこと
   - 完了条件
   - 依存関係
   - リスク
4. `.agents/roles/`の該当ロールで評価する。
5. 評価を統合し、Go / Stop / Revisionを判定する。

## ロール判定

```text
判定: approved / needs_discussion / needs_revision
確認した観点:
懸念:
実装前に確定すべきこと:
次フェーズへ渡す条件:
```

## 統合判定

| 判定 | 条件 | 次の操作 |
|---|---|---|
| Go | 必須ロールがすべてapproved | 技術計画またはTDD実装へ進む |
| Stop | needs_discussionが1つ以上 | 人間へ論点を提示し、編集しない |
| Revision | needs_revisionが1つ以上 | 要件または設計を修正して再判定 |

## ハードストップ

- 完了条件が検証不能。
- 依存Issueが未完了。
- 対象リポジトリ、base branch、変更範囲が曖昧。
- 保護対象の変更に人間承認がない。
- Codex、Devin、GitHub、Gitの責務分担が不明確。
- worktree外変更、cleanup、resume、timeoutの方針が必要なのに未定。
- light条件を満たさないのにlightを選択した。

## 必須成果物

```text
READINESS GATE — Issue #NN（mode: full|light）
統合判定: Go|Stop|Revision
位置づけ:
解く課題:
実装範囲:
今回やらないこと:
依存関係:
変更する境界:
検証方針:
安全上の注意:
ロール要約:
未確定事項:
次フェーズ:
```

## 編集禁止

Go成果物が出るまで、コード、テスト、設定、スキーマを編集しない。調査用の読み取り、Issueコメント案、計画成果物の作成だけを許可する。
