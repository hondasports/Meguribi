---
name: testing-and-quality
description: Meguribi の実装でテスト戦略、fixture、fake executable、品質確認、Definition of Done を適用するスキル。すべてのコード変更で使用する。
---

# テスト・品質スキル

## 使うタイミング

すべてのコード変更、バグ修正、アダプター追加、workflow 変更、schema 変更で使用します。

## 先に読む

- `AGENTS.md`
- `docs/ja/implementation-roadmap.md` のテスト戦略
- 対象スキルのテスト要件

## テストピラミッド

### Unit test

次を外部プロセスなしで検証します。

- target parser
- repository URL 正規化
- branch slug
- config merge
- Valibot schema
- state transition
- label / approval / risk policy
- prompt builder
- secret redaction
- PR / Issue body builder

### Integration test

次を隔離環境で検証します。

- fake `gh` executable を使う `GitHubAdapter`
- temporary Git repository を使う `GitAdapter`
- fake Codex client / event stream
- fake Devin executable
- verifier の process execution
- timeout、signal、non-zero exit、invalid JSON
- atomic write、lock、resume

実際の GitHub、Codex、Devin、利用者リポジトリを通常テストから呼び出してはいけません。

### Workflow fixture test

最低限、次の fixture を用意します。

- `feature-approved`
- `feature-missing-approval`
- `bug-low-risk`
- `protected-path-change`
- `verification-failure`
- `existing-draft-pr`
- `resume-input-changed`
- `dirty-worktree`
- `unsupported-agent-version`

## テスト設計原則

- 正常系だけでなく、部分失敗と中断後再開を検証する。
- 時刻、乱数、ファイルパス、process runner は注入可能にする。
- fixture に token、メールアドレス、実在 private URL を入れない。
- snapshot test だけで仕様を固定しない。重要項目は明示的に assertion する。
- 外部 JSON の欠落・型違い・未知フィールドを検証する。
- Windows / POSIX の path 差異を考慮するか、対応 OS を明記する。

## 実装時の手順

1. Issue の完了条件をテストケースへ対応付ける。
2. 失敗経路を最低1つ定義する。
3. テストしにくい side effect をアダプターへ分離する。
4. fake executable または temporary repository を用意する。
5. 実装とテストを同じ変更に含める。
6. `lint`、`typecheck`、`test`、`build` を実行する。

## 品質確認

- `any`、未検証 cast、握りつぶした例外を増やしていないか。
- エラーメッセージに対象、原因、次の操作が含まれるか。
- stderr や外部 JSON に secret が含まれても redaction されるか。
- retry が無制限でないか。
- cleanup が破壊的でないか。
- 再実行が重複コメント・重複 PR を作らないか。

## 完了条件

- 完了条件ごとのテストがある。
- 重要な異常系がテストされている。
- 実外部サービスへ依存していない。
- 標準検証コマンドの結果を報告できる。
- 未実装の検証を成功扱いしていない。
