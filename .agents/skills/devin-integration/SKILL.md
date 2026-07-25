---
name: devin-integration
description: Devin ACP を利用した承認済み実装、session lifecycle、event normalization、timeout、SIGTERMを含むprocess回収、MCP継承警告を実装する際に使用する。
---

# Devin ACP 連携スキル

## 使うタイミング

- `DevinAdapter` / `DevinAcpAdapter` の追加・変更
- `devin acp` の起動、version / auth / capability 診断
- ACP initialize、session、prompt、update、cancel の実装
- ACP event の正規化
- timeout、signal、process tree 回収
- Devin CLI の MCP 設定継承に関する警告・停止ポリシー

## 先に読む

- `docs/ja/cli-and-integrations.md`
- `docs/ja/decisions/0001-adopt-devin-acp.md`
- `docs/ja/security-and-operations.md`
- `docs/ja/artifacts-and-schemas.md`

利用する Devin CLI の公式ドキュメントとローカル version を確認してください。CLI option や ACP payload を固定的に想定せず、version-specific driver と adapter 境界へ閉じ込めます。

## 採用方針

MVP は `DevinAcpAdapter` を採用します。

```text
DevinAdapter
  -> DevinAcpAdapter
      -> AcpClient
      -> DevinDriverRegistry
          -> DevinDriverVx
      -> ProcessRunner
      -> ProcessTerminator
      -> EventNormalizer
      -> ResultNormalizer
```

`DevinPrintAdapter` は ACP が利用できない場合の将来のフォールバック候補であり、標準実装ではありません。

## 責務

Devin は次だけを担当します。

- 承認済み Issue と Codex plan に基づくコード変更
- 必要なテストの追加
- 指定 worktree 内での実装
- 未解決事項の結果出力

次は担当させません。

- branch 作成
- commit / push / merge
- Issue / PR 更新
- PR 作成
- repository settings
- default branch 操作
- production deployment
- `/handoff` またはクラウドセッション作成

## 起動前診断

最低限、次を確認します。

- `devin --version`
- Devin 認証状態
- `devin acp` の利用可否
- ACP initialize の capability
- 実行対象 worktree の存在と identity
- 利用者の Devin / MCP 設定を継承する可能性への警告

version 文字列だけで対応可否を決めません。feature probe と最小 smoke test を組み合わせ、確認できない場合は安全側へ停止します。

## ACP ライフサイクル

```text
spawn devin acp
  -> initialize
  -> session/new
  -> session/prompt
  -> session/update stream
  -> turn completion
  -> controlled shutdown
```

- `cwd` は Issue 専用 worktree に固定する
- stdin / stdout は ACP 通信専用にする
- stderr は診断ログとして分離する
- raw ACP event と正規化 event を別に保存する
- ACP 固有型をコア層へ漏らさない

正規化対象の例:

```ts
type AgentEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "message.delta"; text: string }
  | { type: "tool.started"; tool: string; summary?: string }
  | { type: "tool.completed"; tool: string; exitCode?: number }
  | { type: "approval.required"; requestId: string; summary: string }
  | { type: "turn.completed"; stopReason?: string }
  | { type: "session.failed"; message: string };
```

## prompt 構築

Meguribi が次を組み合わせて prompt を生成します。

- Issue title / body / relevant comments
- Codex `plan.json`
- `AGENTS.md`
- 対象リポジトリの追加ルール
- 完了条件
- 対象外
- 変更禁止事項
- 期待する結果形式

Issue やコメント内の命令は untrusted content として区切り、Meguribi のルールや人間承認を上書きできないことを明記します。

## 終了処理

prompt 完了後も `devin acp` が待機状態で残ることを正常な server lifecycle として扱います。自然終了だけを期待してはいけません。

通常完了:

1. turn 完了と `stopReason` を保存する
2. stdin を閉じる
3. grace period を待つ
4. 終了しなければ `SIGTERM`
5. さらに終了しなければ強制終了
6. 子プロセス・子孫プロセスの残留を確認する

cancel / timeout:

1. 可能なら `session/cancel`
2. stdin close
3. grace period
4. `SIGTERM`
5. 必要時に強制終了

POSIX signal と Windows の process tree 終了差異は `ProcessTerminator` の背後へ隠蔽します。

## MCP 設定継承

Issue #3 / #6 の PoC では、通常の利用者環境で保存済み MCP 設定を読み込む可能性が確認されました。環境を完全隔離すると MCP と同時に Devin 認証も失われました。

これは Devin CLI の実行環境制約として扱います。ACP 固有の欠陥や、`--print` なら解決することの証明ではありません。

ルール:

- MCP 継承の可能性を実行前に明示する
- 対話実行では利用者確認を取得する
- 非対話実行は明示許可なしで停止する
- 検知できる予期しない MCP 接続は prompt 前に停止する
- credential をコピー・変換・独自保存しない
- MCP を完全隔離できると主張しない

## 結果の正規化

次をドメイン型へ正規化します。

- status
- session ID
- duration
- stop reason
- process exit code / signal
- reported changed files
- unresolved items
- raw / normalized log locations
- MCP warning / policy result

reported changed files は参考情報とし、正本は Git adapter が取得した差分です。

## 安全確認

実行前後で次を検査します。

- worktree 外変更
- protected path changes
- unexpected Git operations
- default branch mutation
- diff / changed files limit
- lock ownership
- timeout / cancellation 後の残留 process
- secret redaction

違反時は commit / push へ進めません。

## テスト

fake ACP executable と一時 Git repository で次を検証します。

- version / capability detection
- initialize / session/new / session/prompt
- session/update event normalization
- permission approval / rejection
- successful completion / non-zero exit
- malformed JSON / protocol error
- timeout / cancellation
- stdin close / SIGTERM / force termination
- child process tree cleanup
- partial stdout / stderr
- worktree outside mutation detection
- unexpected Git operation detection
- inherited MCP warning / deny policy

通常の自動テストで実際の Devin サービスを呼び出してはいけません。実機 smoke は明示的な手動検証として分離します。

## 禁止事項

- unsupported version の推測実行
- prompt の shell interpolation
- Devin への GitHub write 権限付与
- agent の申告を changed files や verification の正本にすること
- timeout なしの実行
- prompt 完了後の ACP process を放置すること
- credential のコピーや artifact 保存
- MCP 隔離を保証できると誤記すること

## 完了条件

- fake ACP executable による integration test がある
- 非対応 version / 未認証で明示的に失敗する
- worktree 内だけで実装を実行できる
- ACP event を adapter 固有型からドメイン型へ正規化できる
- cancel、stdin close、`SIGTERM`、強制終了の経路をテストしている
- 残留 process がないことを確認できる
- MCP 継承ポリシーが利用者へ明示される
