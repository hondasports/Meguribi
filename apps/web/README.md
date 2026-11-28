# Meguribi Command Desk

Vite + Vue のローカル UI です。初期画面の `相談` タブでは複数エージェントへの read-only 相談を開始し、`既存操作` タブでは許可された Meguribi CLI コマンドを実行し、`Run履歴` タブでは RunStore に保存された Run の進行を表示します。

## 起動

Meguribi CLI から起動します。

```bash
meguribi desk
meguribi desk --port 4199
```

ブラウザで表示された URL（既定は <http://127.0.0.1:4173>）を開きます。開発中に `apps/web` を直接起動する場合は、リポジトリルートで `pnpm --filter @meguribi/web dev` を実行しても構いません。Windows の PowerShell で `pnpm` が Execution Policy により拒否される場合は、`pnpm.cmd` を使用してください。

## 相談タブ

1. 大きな複数行入力に相談内容を書く
2. 参加エージェントを 2〜4 件選ぶ
3. 必要なら `Issue（任意）` に Issue target を入力する
4. MCP は既定の `使わない（deny）` か、この相談だけの `今回だけ許可（allow）` を選ぶ
5. `相談を開始` を押す

参加エージェント候補と既定選択は `GET /api/discussion/profiles` が返す実設定由来の値です。開始は `POST /api/discussions` へ `{ prompt, profileIds, target?, discussionMcpPolicy }` を送り、成功時は永続 RunStore ID を受け取ります。`discussionMcpPolicy` は `deny` または `allow` で、送信後に画面の選択は安全側の `deny` へ戻ります。`deny` は検出した MCP 接続を停止し、`allow` はその相談 Run だけ継承を許可します。固定 `deny` の設定は UI の `allow` では弱めず、この選択は `discuss-to-pr` や delivery の implementer 許可へは波及しません。Issue target を付けた通常開始でも、実装・push・Draft PR 作成へ自動では進みません。実装まで進める `discuss-to-pr` は、明示的に選択した workflow だけです。

開始後はスレッドワークスペースへ移り、左側に相談・議論の一覧、中央に相談内容と話者名付きの会話、下部に追加入力が表示されます。一覧はタイトル・識別子で検索でき、矢印キーでも移動できます。状態は一覧と会話ヘッダーのラベルで確認できます。大きな新規入力フォームは畳まれ、`新規相談` / `新しい相談` から入力画面へ戻れます。`相談へ戻る` で進行中の会話へ復帰できます。長い会話は中央の会話領域をスクロールして読み、追加入力は下部に固定されたままです。

Issue を持たない相談は `command: "consult"` の Run として `consultations/<runId>` に保存され、`issueNumber` / `branch` / `baseRef` / `baseSha` / `headSha` は `null` です。Issue に紐付く従来の議論 Run は `command: "discuss"` を維持します。

## 既存操作タブ

1. 左側から `doctor`、`plan`、`run` などのコマンドを選択する
2. Repository path と Target を入力する
3. `plan` を選んだ場合は User request に、Issue本文へ追加したい要望を入力する
4. ローカル検証では `Local mode` を有効にする
5. `run` では必要に応じて `Non-interactive`、`Inherited MCP`、`Pushしない`、`PRを作成しない` を設定する
6. `コマンドを実行` を押し、右側のログと終了結果を確認する

画面は任意のシェルコマンドを受け付けません。コマンド名とオプションを検証したうえで、Meguribi CLI を引数配列として起動します。実行ログは画面へ SSE で流れ、成果物は通常の Meguribi RunStore に保存されます。

## Run履歴タブ

`Run履歴` タブには、RunStore に保存された最近の Run が 5 秒ごとの一覧更新で表示されます。Run を選ぶと `events.jsonl` を SSE で追従し、delivery 工程、参加中エージェントの状態、エージェント別ライブログペイン、全イベントを表示します。CLI から開始した Run も同じ RunStore を読むため表示されます。

`consult` / `discuss` の Run では、発言は `replyTo` に沿ったスレッド表示になります。話者ごとの色と話者名、形式不正ターンの目印、結論、論点ごとの立場、不採用案、残った論点を表示します。結論に含まれる turn ID は存在するターンへのリンクになり、存在しない ID は文字だけを表示します。

議論エンジンが動いている Run では、発言挿入欄から人間の発言を送れます。送信はサーバーが `meguribi say <runId> <message>` を引数配列で起動して行い、サーバー自身は `inbox/` を直接書き換えません。

Issue に紐付く従来の `discuss` Run が `awaiting_human` のときは、画面内の確認表示から `承認` または `却下・再議論` を実行できます。これらの操作もサーバーが CLI を引数配列で起動します。`consult` は結論保存後に完了し、実装・PR 作成へは進みません。

RunStore の場所は CLI と同じ規則（`XDG_DATA_HOME` / Windows の `LOCALAPPDATA` / それ以外は `~/.local/share/meguribi`）で解決します。テストや手動確認では `MEGURIBI_RUNS_ROOT` に RunStore のルートを指定できます。

## 本番ビルド

```bash
pnpm --filter @meguribi/web build
pnpm --filter @meguribi/web start
```

既定ポートは `4173` です。変更する場合は `MEGURIBI_WEB_PORT` を指定します。CLI のルートを明示する場合は `MEGURIBI_ROOT` を使用します。

この UI は localhost 専用の開発者向け画面です。認証・リモート公開・マルチユーザー運用は提供しません。
