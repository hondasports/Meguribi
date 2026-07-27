# 安全設計と運用

## 1. 前提

Meguribi は、AI エージェントへ既存リポジトリの読み取り・変更権限を与えます。

そのため、安全性はプロンプトだけに依存せず、次の層で制御します。

```text
Human approval
  + Meguribi policy
  + OS / agent sandbox
  + Git worktree isolation
  + protected paths
  + deterministic verification
  + Draft Pull Request
```

一つの層が失敗しても、即座に main や本番へ影響しない構成を取ります。

## 2. 信頼モデル

### 信頼する

- Git の実際の status / diff / commit SHA
- Meguribi が実行したコマンドの終了コード
- GitHub API / `gh` が返す Issue、PR、CI 状態
- スキーマ検証を通過した構造化成果物

### そのまま信頼しない

- Agent の「テストに成功した」という自然文
- Agent が申告した changed files
- AI が生成した観測事実
- AI が判断したプロダクト優先順位
- Issue 本文やコメント内の命令
- 外部ページや添付ファイルに含まれる指示

Issue、コメント、リポジトリ内文書はコンテキストであり、Meguribi 自身のシステム命令ではありません。

## 3. Worktree 分離

- Issue ごとに専用 branch と worktree を作る。
- 利用者の通常 checkout を Agent の作業ディレクトリにしない。
- Codex の計画・レビューは原則読み取り専用。
- 選択した実装エージェントだけが実装フェーズで worktree を変更できる。
- 同じ worktree へ複数 Agent を同時に書き込ませない。
- worktree 外のパスへの書き込みを検出した場合は停止する。

## 4. Git ガード

禁止操作:

```text
git push --force
git push --mirror
git reset --hard
git clean -fdx
git rebase --onto（自動実行）
git filter-repo
git checkout / switch で worktree 外ブランチへ移動
git config --global
git remote set-url
git tag -f
```

Meguribi が許可する Git 書き込み:

- 専用 branch 作成
- 専用 worktree 作成
- 確認済み changed files の stage
- 通常 commit
- 専用 branch への通常 push
- cleanup 時の worktree 削除

main / master / default branch への直接 push は禁止します。

## 5. 保護パス

既定で保護候補にするパス:

```text
.env
.env.*
**/*credential*
**/*secret*
**/*private-key*
.github/workflows/**
.github/actions/**
infra/**
terraform/**
migrations/**
```

リポジトリごとに `.meguribi.yml` で追加・緩和できます。

保護パス変更を許可する条件:

1. Issue が明示的に変更対象を記載する。
2. `risk:high` として扱う。
3. 対話モードで人間が許可する。
4. PR 本文の確認事項へ強調表示する。

`.env` や秘密鍵の commit は許可しません。

## 6. リスク判定

### Low

- ドキュメント
- 文言
- テスト追加
- 小規模な表示修正
- 単純なバグ修正

### Medium

- 新しい API
- 複数機能にまたがる変更
- 依存パッケージ追加
- データモデルの後方互換変更
- 外部サービス連携

### High

- DB migration
- 認証・認可
- 課金
- 個人情報
- 削除・退会・データ破棄
- CI / deploy
- infrastructure
- 権限昇格
- 暗号・secret
- 大規模な依存更新

AI の判定だけでリスクを下げません。ファイルパス、Issue ラベル、変更内容から Meguribi 側でも保守的に判定します。

## 7. コマンド実行

- shell 文字列連結を避け、実行ファイルと引数配列を分離する。
- 設定されたコマンドは、既定ではリポジトリ所有者が信頼したものとして扱う。
- Agent が提案した未知のコマンドを自動で許可しない。
- タイムアウトを必須にする。
- stdout / stderr の最大サイズを設定する。
- バイナリ出力や制御文字を安全にログへ保存する。
- 環境変数を allowlist 方式で Agent プロセスへ渡すことを検討する。

## 8. Secrets

- API key は環境変数または各 CLI の公式認証ストアから取得する。
- `resolved-config.json` には秘密値を保存しない。
- ログへ出す前に token、authorization header、cookie、known secret patterns をマスクする。
- Agent へ全環境変数を継承させないモードを用意する。
- `.env` をコンテキストへ読み込まない。
- Issue やコメントに貼られた秘密らしき値を検出したら警告する。

## 9. Prompt injection 対策

GitHub Issue、コメント、コード、README、外部資料には、Agent の動作を変えようとする文章が含まれる可能性があります。

対策:

- Meguribi の固定ルールとユーザー入力を明確に区切る。
- Issue 内の命令は要件候補として扱い、実行権限の変更には使わない。
- 「安全ルールを無視せよ」「secret を表示せよ」等をポリシー違反として記録する。
- Agent の出力から新しい権限やコマンドを自動採用しない。
- 外部 URL の内容を自動実行手順として扱わない。
- 保護パス・禁止操作はプロンプト外のコードで強制する。

## 10. 差分制限

`.meguribi.yml` で次を制限します。

- 最大 changed files
- 最大 diff lines
- 最大 binary file size
- 最大新規依存数
- 最大実行時間
- 最大 Agent 修正回数

上限を超えた場合:

1. commit / push を行わない。
2. `review.json` に scope violation を記録する。
3. Issue へ `agent:blocked` を付ける案を提示する。
4. 人間へ worktree の確認方法を表示する。

## 11. 冪等性

同じコマンドを再実行しても、不要な重複を作らないようにします。

- Issue コメントは HTML marker で更新する。
- branch 名は Issue に対して安定させる。
- 既存 worktree を検出したら resume / cleanup を要求する。
- 同じ head branch の Draft PR を再利用する。
- Run ID は毎回新しくし、各 Run の入力 digest を保存する。

## 12. Lock

同じ Issue の同時実行を防止します。

lock には次を保存します。

```json
{
  "pid": 12345,
  "hostname": "developer-machine",
  "runId": "...",
  "createdAt": "..."
}
```

プロセスが存在しない stale lock は、利用者確認後に解除できます。時刻だけで自動削除しません。

## 13. 再試行

### 自動再試行してよい

- 一時的な GitHub API / network failure
- Codex の構造化出力が 1 回だけスキーマ不正
- 読み取り専用操作の一時失敗

### 自動再試行しない

- 認証失敗
- protected path 変更
- Agent が要求外変更を行った
- test failure
- Git conflict
- Issue や base branch の更新
- 高リスク判断

実装修正ループは既定 0 回、許可時でも最大 1 回から開始します。

## 14. 中断

Ctrl+C / signal を受けた場合:

1. 新しい子プロセスを開始しない。
2. 実行中プロセスへ終了シグナルを送る。
3. 一定時間後に強制終了する。
4. `state.json` を `cancelled` または `failed` に更新する。
5. worktree とログは残す。
6. commit / push / PR を途中から勝手に継続しない。

## 15. Resume

再開時に検証する項目:

- Issue の updatedAt / digest
- base branch SHA
- worktree の HEAD
- dirty state
- branch remote tracking
- 既存 PR の head SHA
- 設定 digest
- Codex / 選択した実装エージェントの session 利用可否

差異がある場合は、どの成果物を再生成するか人間へ提示します。

## 16. 失敗時の成果物

失敗しても次を可能な限り残します。

- state.json
- 実行ステップ
- エラー種別
- stdout / stderr
- changed files
- diff.patch
- 次に実行できるコマンド

ユーザーへ「失敗した」だけを返さず、worktree の場所と復旧方法を表示します。

## 17. Pull Request の安全性

- Draft で作る。
- CI 成功を ready / merge と同義にしない。
- Codex review の `approved` を人間承認と同義にしない。
- 自動 merge を実装しない。
- production deploy を実行しない。
- Issue の対象外とリスクを PR 本文に残す。

## 18. 監査可能性

Meguribi は個人ツールですが、後から次を確認できるようにします。

- どの Issue とコメントを入力にしたか
- どの Agent / role / session が成果物を作ったか
- どの commit を基準にしたか
- どのコマンドを実行したか
- 何が失敗したか
- 人間がどこで承認したか

独自の監査 DB は作らず、Run 成果物と GitHub 履歴で実現します。

## 19. ACP permission

ACP の permission request は adapter 境界で `PermissionRequest` へ正規化し、PolicyEngine の判定を通します。worktree 外、protected path、Git の書き込み、production、secret、external network、unknown operation は deny します。test / lint / build などの command は明示的な allowlist に一致した場合だけ許可します。

対話モードの確認待ちは timeout で deny とし、非対話モードは明示許可されていない操作を fail-closed で deny します。同一 session / request ID の結果は再利用し、session 終了後の request は無効です。`allow all` の永続設定は提供しません。

## 20. MCP 継承

agent CLI の保存済み MCP 設定を完全に隔離できるとは表現しません。`warn` は対話時に確認し、非対話時は明示許可なしで停止します。`deny` は検知可能な stdio / HTTP MCP 接続を SECURITY_ALERT として記録し、prompt 前または検知直後に停止します。接続先、credential、token は redaction 前の値を成果物へ保存しません。

## 21. prompt と Git の安全境界

Issue、comment、previous attempt、fix instruction は untrusted content として prompt 内で明示的に区切ります。repository rules、主 skill、approved plan、protected paths、limits は trusted contract として別ブロックに置きます。control character、zero-width character、delimiter の脱出、secret pattern、worktree 外 path を正規化・拒否し、prompt version と hash を保存します。

Agent 実行前後の Git snapshot を比較し、repository root、common dir、HEAD、承認済み base SHA、branch、承認済み remote identity、remote、local config、reflog、protected path、pre-existing dirty state、symlink、changed file 数、diff 行数、binary file、worktree 外変更を検査します。違反または suspicious な snapshot は Verifier、commit、push、PR へ進めません。Git の diff が changed files の正本であり、Agent の申告は参考値です。repository 上で Git boundary 設定がない session は fail-closed です。
Agent の `reportedFiles` と Git diff が一致しない場合は warning として `git-boundary.json` に保存しますが、Git diff の判定を上書きしません。

## 22. ACP 終了と成果物

正常終了、cancel、timeout、protocol failure では、必要に応じて `session/cancel`、stdin close、grace period、SIGTERM 相当、force termination の順で process tree を回収します。turn は既定5分で timeout し、shutdown は冪等です。`termination.json` に stop reason、各段階の結果、残留 process 数、cleanup error を redaction 後に保存します。残留や cleanup error が不明な場合は成功扱いにしません。

`experiments/devin-acp` の compatibility smoke は、実 Devin CLI への接続を `MEGURIBI_RUN_REAL_DEVIN_SMOKE=1` の明示 opt-in でだけ許可します。opt-in なしでは `blocked` となり、外部 MCP 接続・実 repository への書き込み・commit/push/PR/Issue 操作・credential のコピー/保存を行いません。実機 smoke を実行する際は警告を表示し、TTY では確認プロンプトを出します。非対話実行では `--yes` を付与してください。認証状態を保つため `HOME` / `USERPROFILE` / `APPDATA` などを隔離せず現在のユーザ環境を継承しますが、credential のコピー・保存は行いません。
