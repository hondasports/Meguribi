# Devin CLI ACP PoC

Issue #3 のための隔離検証用 PoC です。本番の `DevinAdapter` や Delivery workflow からは呼び出しません。

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

認証済み Devin CLI を使う実機 smoke:

```powershell
pnpm smoke
```

一時 fixture の `README.md` だけを編集対象として許可します。Git、terminal、network、secret 関連の permission request は拒否します。生成物はリポジトリルートの `artifacts/devin-acp/<run-id>/` に保存され、Git 管理対象外です。

## 通信と終了

子プロセスは次の条件で起動します。

- executable と引数を分離し、`shell: false`
- `cwd` は専用 worktree
- stdin / stdout / stderr を pipe
- stdout は ACP NDJSON、stderr は診断ログ

PoC は `initialize`、`session/new`、`session/prompt` を実行します。timeout / cancel では `session/cancel` を送信し、prompt 完了または子プロセス終了を待ちます。ACP に未確認の `session/end` は送信しません。

## 生成物

- `events.jsonl`: ACP stdout の raw stream（redaction 後）
- `normalized-events.jsonl`: Meguribi PoC 内の正規化イベント
- `session.json`: protocol / agent / session metadata
- `stderr.log`: Devin の stderr（redaction 後）
- `result.json`: 終了状態、変更ファイル、worktree 外変更、permission 結果

ログへ環境変数全体、token、cookie、API key、認証情報は保存しません。実機 smoke は実在のプロダクトリポジトリでは実行しないでください。
