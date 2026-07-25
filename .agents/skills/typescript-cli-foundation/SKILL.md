---
name: typescript-cli-foundation
description: Meguribi の Node.js・TypeScript・pnpm workspace、CLI entry point、設定読み込み、診断コマンドを実装する際に使用する。
---

# TypeScript CLI 基盤スキル

## 使うタイミング

- Phase 0 のリポジトリ基盤
- `init`、`--help`、`--version`
- `.meguribi.yml` の読み込みと生成
- dependency / authentication diagnostics
- package 構成や build 設定の変更

## 先に読む

- `docs/ja/architecture.md`
- `docs/ja/cli-and-integrations.md`
- `docs/ja/implementation-roadmap.md` の Phase 0 と `init`

## 推奨構成

```text
apps/
  cli/
packages/
  core/
  adapters/
  schemas/
  test-support/
prompts/
tests/fixtures/
```

CLI entry point は薄く保ち、次だけを担当させます。

1. 引数解析
2. dependency 構築
3. use case 呼び出し
4. 人間向け出力と exit code

## 実装方針

- 実装着手時点で公式に提供されている最新の Node.js LTS メジャーを採用する。2026年7月時点では Node.js 24（Krypton）。
- 採用したメジャーは、`package.json` の `engines`、`.node-version` または `.nvmrc`、CI で固定・一致させる。
- 新しいLTSメジャーへは自動追従せず、依存関係とCIの互換性を確認する明示的な変更として更新する。
- Current リリースは使用せず、LTS へ昇格したメジャーだけを採用する。
- TypeScript strict、pnpm を前提とする。
- ESM / CJS は最初に一つへ固定し、混在させない。
- Commander 等の CLI parser を利用する。
- process 実行は共通 `ProcessRunner` を経由する。
- config は Zod schema で検証し、既定値と project 設定の merge を純粋関数にする。
- XDG Base Directory を優先し、OS 固有 path を一箇所へ閉じ込める。
- `--json` 出力を追加する場合、人間向け stdout と混ぜない。

## `.meguribi.yml`

最低限、次を扱える設計にします。

- base branch
- verify commands
- protected paths
- diff / changed files limits
- approval labels
- agent command / timeout
- draft PR policy

未知キーを黙って無視するか拒否するかを schema version 単位で明示してください。

## `init` の診断

- local Git repository の解決
- remote URL の正規化
- GitHub repository identity
- `git`、`gh`、Codex、Devin の存在と version
- Node.js がリポジトリで固定された LTS メジャーと一致しているか
- `gh` 認証
- default branch
- `.meguribi.yml` の有無
- run / worktree 保存先への書き込み可否

診断は可能な限り読み取り専用にし、既存設定を確認なしに上書きしません。

## エラー設計

- dependency missing
- unsupported version
- invalid configuration
- ambiguous repository
- authentication required
- permission denied

エラーには、対象、原因、利用者が次に実行するコマンドを含めます。

## テスト

- CLI argument parsing
- help / version
- config defaults / override / invalid input
- remote URL normalization
- dependency diagnostics with fake executables
- Node.js LTS major mismatch diagnostics
- existing config overwrite protection
- Windows / POSIX path fixture

## 完了条件

- `pnpm meguribi --help` が動く。
- lint / typecheck / test / build が CI とローカルで一致する。
- Node.js の LTS メジャーがローカル、`package.json`、バージョン管理ファイル、CI で一致する。
- CLI 層に外部ツール固有ロジックがない。
- 不足 dependency を具体的に案内する。