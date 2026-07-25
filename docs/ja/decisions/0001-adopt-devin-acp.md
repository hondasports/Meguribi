# ADR 0001: Devin 実装 transport に ACP を採用する

- Status: Accepted
- Date: 2026-07-25
- Related: Issue #3, Issue #6, PR #5, PR #7

## Context

Meguribi は、承認済み Issue の実装担当としてローカルの Devin CLI を利用する。

候補 transport は次の2つだった。

1. `devin acp` を stdio ACP server として起動する `DevinAcpAdapter`
2. `devin --print` などの非対話 CLI を使う `DevinPrintAdapter`

Issue #3 の PoC では、`devin acp` を TypeScript から子プロセス起動し、`initialize`、`session/new`、`session/prompt`、`session/update`、`session/cancel` を扱えることを確認した。Issue 専用 fixture worktree 内の変更にも成功し、通常 checkout や worktree 外の変更はなかった。

一方、通常の利用者環境では、Devin CLI が保存済み MCP 設定を読み込む可能性が確認された。Issue #6 では、`HOME` や XDG 系ディレクトリを隔離すると保存済み MCP を遮断できたが、同時に Devin の認証も失われた。

Issue #6 は当初、この結果から `DevinAcpAdapter` 不採用と判断した。しかし、この実験は `--print` と ACP を同一条件で比較しておらず、MCP 設定継承が ACP 固有であることも、`--print` へ変更すれば解決することも証明していない。

## Decision

MVP の Devin transport として `DevinAcpAdapter` を採用する。

理由:

- 構造化された session / event を取得できる
- permission request を扱える
- `session/cancel` を使用できる
- turn 完了、tool 実行、エラーを正規化しやすい
- `RunStore` と進捗表示へ統合しやすい
- `--print` が設定・認証問題を解決する根拠がない

`DevinPrintAdapter` は ACP の互換性が失われた場合のフォールバック候補に留める。

## Controlled shutdown

`devin acp` は prompt 完了後も server として待機するため、Meguribi が明示的に process lifecycle を管理する。

通常完了:

1. turn 完了と `stopReason` を保存
2. stdin を閉じる
3. grace period を待つ
4. 終了しなければ `SIGTERM`
5. 必要時に強制終了
6. process tree の残留確認

cancel / timeout 時は、可能なら `session/cancel` を送ってから同じ終了シーケンスへ進む。

Windows では `SIGTERM` と同等の process tree termination を platform adapter の背後へ隠蔽する。

## MCP inheritance policy

MCP 設定継承は ACP 固有の欠陥ではなく、Devin CLI の実行環境制約として扱う。

- 実行前に、保存済み MCP 設定を継承する可能性を警告する
- 対話実行では利用者確認を取る
- 非対話実行では明示許可なしで停止する
- 検知できる予期しない MCP 接続は prompt 前に停止する
- credential をコピー、変換、Meguribi 独自形式で保存しない
- MCP を完全隔離済みと表現しない

## Consequences

### Positive

- Devin の進捗、permission、cancel、session 情報を構造化して扱える
- Codex SDK と異なる transport でも、Meguribi 内部の `AgentEvent` へ統一できる
- Issue 単位の timeout、resume、監査ログを実装しやすい

### Negative

- prompt 完了後に明示的な process 回収が必要
- Devin CLI の保存済み MCP 設定を継承する可能性が残る
- 非対話実行では安全側へ停止するケースが増える
- ACP payload や CLI version 差異を adapter / driver で吸収する必要がある

## Revisit conditions

次の場合は transport を再評価する。

- Devin CLI が公式な MCP deny-all / allowlist と認証分離機構を提供した
- ACP compatibility が失われた
- ACP で安全な process 回収ができなくなった
- `--print` など別 transport に明確な安全性・機能上の優位が確認された
