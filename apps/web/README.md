# Meguribi Command Desk

Vite + Vue のローカル UI から、Meguribi の許可された CLI コマンドを実行し、RunStore に保存された Run の進行を読み取り専用で表示する画面です。

## 起動

Meguribi CLI から起動します。

```bash
meguribi desk
meguribi desk --port 4199
```

ブラウザで表示された URL（既定は <http://127.0.0.1:4173>）を開きます。開発中に `apps/web` を直接起動する場合は、リポジトリルートで `pnpm --filter @meguribi/web dev` を実行しても構いません。Windows の PowerShell で `pnpm` が Execution Policy により拒否される場合は、`pnpm.cmd` を使用してください。

## コマンドタブ

1. 左側から `doctor`、`plan`、`run` などのコマンドを選択する
2. Repository path と Target を入力する
3. `plan` を選んだ場合は User request に、Issue本文へ追加したい要望を入力する（例: `WEBでTODOアプリを作って。`）
4. ローカル検証では `Local mode` を有効にする
5. `run` では必要に応じて `Non-interactive`、`Inherited MCP`、`Pushしない`、`PRを作成しない` を設定する
6. `コマンドを実行` を押し、右側のログと終了結果を確認する

画面は任意のシェルコマンドを受け付けません。コマンド名とオプションを検証したうえで、Meguribi CLI を引数配列として起動します。実行ログは画面へ SSE で流れ、成果物は通常の Meguribi RunStore に保存されます。

`plan` の User request は CLI の `--request` として渡され、Issue本文・リポジトリ・AGENTS.md のルールと合わせてCodexの読み取り専用計画へ反映されます。12,000文字を超える入力や空入力は受け付けません。

## Run タブ

`Run` タブには、RunStore に保存された最近の Run が 5 秒ごとの一覧更新で表示されます。Run を選ぶと `events.jsonl` を SSE で追従し、次を表示します。

- delivery 工程のパイプライン（`plan` → `implement` → `verify` → `review` → fix → `publish`）
- 参加中エージェントの状態、内容、経過時間、応答なし警告
- エージェント別ライブログペイン
- 全イベントを 1 本で表示する `全体` タブ

Command Desk から開始した Run だけでなく、CLI で `meguribi run` / `resume` を実行した Run も同じ RunStore を読むため表示されます。Run 画面の API は読み取り専用で、Run の状態やファイルを書き換えません。

RunStore の場所は CLI と同じ規則（`XDG_DATA_HOME` / Windows の `LOCALAPPDATA` / それ以外は `~/.local/share/meguribi`）で解決します。テストや手動確認では `MEGURIBI_RUNS_ROOT` に RunStore のルートを指定できます。

## 本番ビルド

```bash
pnpm --filter @meguribi/web build
pnpm --filter @meguribi/web start
```

既定ポートは `4173` です。変更する場合は `MEGURIBI_WEB_PORT` を指定します。CLI のルートを明示する場合は `MEGURIBI_ROOT` を使用します。

この UI は localhost 専用の開発者向け画面です。認証・リモート公開・マルチユーザー運用は提供しません。
