---
name: tdd-implement
description: Issue Readiness GateのGo後に、失敗するテストから始めて最小変更で完了条件を満たす。CLI、ユースケース、アダプター、スキーマの振る舞い変更やバグ修正で使用する。
---

# TDD実装

## 前提

- `issue-readiness-gate`のGo成果物がある。
- Issue専用ブランチまたはworktreeで作業している。
- 対象領域の専門スキルを読んでいる。
- 実装範囲と今回やらないことが確定している。

## 基本サイクル

1. 期待する振る舞いを1つ選ぶ。
2. その振る舞いを証明する最小テストを先に追加する。
3. テストが期待した理由で失敗することを確認する（RED）。
4. 最小の本体変更でテストを通す（GREEN）。
5. 必要な整理だけを行い、関連テストを再実行する（REFACTOR）。
6. 次の振る舞いへ進む。

## テストの選択

- parser、slug、schema、policy、state transition: Unit test。
- ProcessRunner、GitHub/Git/Codex/Devin adapter: fake executableまたはfake clientを使うIntegration test。
- Git worktree: 一時Gitリポジトリを使うIntegration test。
- plan/run/review/resume/cleanup: fixtureベースのworkflow test。
- 実CLI接続: 自動テストへ混ぜずmanual smokeとして分離する。

## 必須の失敗経路

変更対象に応じて次を含める。

- invalid input / invalid schema。
- dependency missing / unsupported version。
- authentication failure。
- timeout / SIGINT / SIGTERM。
- partial write / atomic write failure。
- protected path / worktree外変更。
- stale lock / resume digest mismatch。
- subprocess non-zero exit。

## 実装原則

- Issueの完了条件を直接証明するテストを優先する。
- SDK/CLIの生レスポンスではなく、正規化後のドメイン型をテストする。
- shellを介さず実行ファイルと引数配列を渡す。
- 時刻、UUID、filesystem、processは注入可能にして決定的にテストする。
- fixtureにsecret、token、実在ユーザー情報を含めない。
- Codex、Devin、GitHubの実サービスを通常テストから呼ばない。
- テストを通すために検証や安全策を弱めない。

## 証拠

作業報告またはPRに次を残す。

```text
RED:
- テスト名:
- 期待した失敗:

GREEN:
- 実装概要:
- 通過したテスト:

追加確認:
- lint:
- typecheck:
- test:
- build:
```

## 停止条件

- Go成果物なしで実装しようとしている。
- 失敗するテストなしで振る舞い変更を行おうとしている。
- 同じ失敗を2回繰り返した。`stuck-advisor`へ移る。
- Issue外の変更が必要になった。現在の実装を止めてスコープを再確認する。

## 完了条件

- RED/GREENの証拠がある。
- 完了条件をテストまたは明示的なmanual smokeで検証できる。
- スコープ外変更がない。
- 次の`verify-pre-push`へ渡せる状態になっている。
