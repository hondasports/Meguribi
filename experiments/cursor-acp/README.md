# Cursor CLI ACP / MCP Isolation PoC

Issue #32 のための隔離検証用 PoC です。本番の `CursorAcpAdapter` や Delivery workflow からは呼び出しません。

## 前提

- Node.js 24
- pnpm
- Cursor CLI が `PATH` に存在すること（実機 smoke のみ）
- 実機 smoke は Cursor の認証済み CLI と一時 Git worktree を使用します。

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
pnpm smoke:cursor-acp:fake
```

fake smoke のシナリオは `MEGURIBI_FAKE_CURSOR_SCENARIO` で切り替えます。

```powershell
$env:MEGURIBI_FAKE_CURSOR_SCENARIO = "write-outside"
pnpm smoke:cursor-acp:fake
```

認証済み Cursor CLI を使う実機 smoke:

```powershell
$env:MEGURIBI_RUN_REAL_CURSOR_SMOKE = "1"
pnpm smoke:cursor-acp -- --yes
```

実機smokeは明示opt-inがない限り外部agentを起動せず、未認証・ACP非対応・MCP policy不許可・worktree境界違反・shutdown失敗のいずれかで安全側に停止します。実在プロダクトrepository、commit、push、PR、Issue更新、外部MCP接続は行いません。実行前に警告を表示し、TTY では確認プロンプトを出します。非対話実行では `--yes` を付与してください。Cursor 利用料金、ネットワーク通信、保存済み認証・MCP 設定継承の可能性があるため、内容を確認してから実行してください。

MCP は `inheritedMcpPolicy: deny` で fail-closed にしますが、完全な機械的隔離は保証できません。認証を保つため、実機 smoke は `HOME` / `USERPROFILE` / `APPDATA` などの隔離を行わず、現在のユーザ環境を継承します。credential をコピー・保存することはありません。

一時 fixture の `README.md` だけを編集対象として許可します。Git、terminal、network、secret 関連の permission request は拒否します。生成物はリポジトリルートの `artifacts/cursor-acp/<run-id>/` に保存され、Git 管理対象外です。compatibility smokeでは `compatibility-result.json`、`raw-events.jsonl`、`events.jsonl`、`session.json`、`termination.json`、`git-boundary.json`、`stderr.log`、`cursor-prompt.md` を確認できます。認証ファイル、token、cookie、全環境変数は保存しません。

## 通信と終了

子プロセスは次の条件で起動します。

- executable と引数を分離し、`shell: false`
- `cwd` は専用 worktree
- stdin / stdout / stderr を pipe
- stdout は ACP NDJSON、stderr は診断ログ

PoC は `initialize`、`session/new` または `session/load`、`session/prompt` を実行します。timeout / cancel では `session/cancel` を送信し、prompt 完了または子プロセス終了を待ちます。ACP に未確認の `session/end` は送信しません。stderr または fake MCP marker で想定外MCP接続を検知した場合は、promptを継続せず、cancel、stdin close、SIGTERM、必要時の強制終了へ進みます。

## 生成物

- `events.jsonl`: ACP stdout の raw stream（redaction 後）
- `normalized-events.jsonl`: Meguribi PoC 内の正規化イベント
- `session.json`: protocol / agent / session metadata
- `stderr.log`: Cursor の stderr（redaction 後）
- `result.json`: 終了状態、変更ファイル、worktree 外変更、permission 結果
- `result.json` の `mcp` / `diagnosis`: 設定source、deny-all / allowlist判定、redacted接続情報、認証維持可否、採用候補判定

ログへ環境変数全体、token、cookie、API key、認証情報は保存しません。isolated variant は `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME` をartifact配下へ変更し、認証ファイルをコピーしません。そのため認証状態が失われる場合は、ACP採用不可として記録します。実機 smoke は実在のプロダクトリポジトリでは実行しないでください。
