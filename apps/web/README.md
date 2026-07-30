# Meguribi Command Desk

Vite + Vue のローカル UI から、Meguribi の許可された CLI コマンドを実行するための画面です。

## 起動

リポジトリルートから実行します。

```powershell
pnpm.cmd --filter @meguribi/web dev
```

ブラウザで <http://127.0.0.1:4173> を開きます。

Windows の PowerShell で `pnpm` が Execution Policy により拒否される場合は、`pnpm.cmd` を使用してください。

## 使い方

1. 左側から `doctor`、`plan`、`run` などのコマンドを選択する
2. Repository path と Target を入力する
3. ローカル検証では `Local mode` を有効にする
4. `run` では必要に応じて `Non-interactive`、`Inherited MCP`、`Pushしない`、`PRを作成しない` を設定する
5. `コマンドを実行` を押し、右側のログと終了結果を確認する

画面は任意のシェルコマンドを受け付けません。コマンド名とオプションを検証したうえで、Meguribi CLI を引数配列として起動します。実行ログは画面へ SSE で流れ、成果物は通常の Meguribi RunStore に保存されます。

## 本番ビルド

```powershell
pnpm.cmd --filter @meguribi/web build
pnpm.cmd --filter @meguribi/web start
```

既定ポートは `4173` です。変更する場合は `MEGURIBI_WEB_PORT` を指定します。CLI のルートを明示する場合は `MEGURIBI_ROOT` を使用します。

この UI は localhost 専用の開発者向け画面です。認証・リモート公開・マルチユーザー運用は提供しません。
