# Devin CLI ACP / MCP Isolation PoC

Issue #3 / #6 のための隔離検証用 PoC です。本番の `DevinAdapter` や Delivery workflow からは呼び出しません。

## 前提

- Node.js 24
- pnpm
- Devin CLI が `PATH` に存在すること（実機 smoke のみ）
- 実機 smoke は Devin の認証済み CLI と一時 Git worktree を使用します。

## セットアップと検証

```powershell
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

fake ACP executable を使う隔離 smoke:

```powershell
pnpm smoke -- --fake
```

fake MCP の deny-all / allowlist 検証:

```powershell
pnpm smoke -- --fake --mcp-stdio
pnpm smoke -- --fake --mcp-stdio --allow-fake-mcp
pnpm smoke -- --fake --mcp-http
pnpm smoke -- --fake --mcp-http --allow-fake-mcp
```

設定探索元を切り替える場合は、`DEVIN_ACP_VARIANT` に `inherited`、`config-only`、`isolated`、`project`、`local`、`agent-config` のいずれかを指定します。実機 Devin smoke は保存済み設定を誤って利用しないため `isolated` variant だけを許可します。

認証済み Devin CLI を使う実機 smoke:

```powershell
pnpm smoke
```

CLI version / help と認証状態だけを機械診断する場合:

```powershell
pnpm diagnose
```

一時 fixture の `README.md` だけを編集対象として許可します。Git、terminal、network、secret 関連の permission request は拒否します。生成物はリポジトリルートの `artifacts/devin-acp/<run-id>/` に保存され、Git 管理対象外です。

## 通信と終了

子プロセスは次の条件で起動します。

- executable と引数を分離し、`shell: false`
- `cwd` は専用 worktree
- stdin / stdout / stderr を pipe
- stdout は ACP NDJSON、stderr は診断ログ

PoC は `initialize`、`session/new`、`session/prompt` を実行します。timeout / cancel では `session/cancel` を送信し、prompt 完了または子プロセス終了を待ちます。ACP に未確認の `session/end` は送信しません。stderr または fake MCP marker で想定外MCP接続を検知した場合は、promptを継続せず、cancel、stdin close、SIGTERM、必要時の強制終了へ進みます。

## 生成物

- `events.jsonl`: ACP stdout の raw stream（redaction 後）
- `normalized-events.jsonl`: Meguribi PoC 内の正規化イベント
- `session.json`: protocol / agent / session metadata
- `stderr.log`: Devin の stderr（redaction 後）
- `result.json`: 終了状態、変更ファイル、worktree 外変更、permission 結果
- `result.json` の `mcp` / `diagnosis`: 設定source、deny-all / allowlist判定、redacted接続情報、認証維持可否、採用候補判定

ログへ環境変数全体、token、cookie、API key、認証情報は保存しません。isolated variant は `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME` をartifact配下へ変更し、認証ファイルをコピーしません。そのため認証状態が失われる場合は、ACP採用不可として記録します。実機 smoke は実在のプロダクトリポジトリでは実行しないでください。
