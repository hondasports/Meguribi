# GitHub 運用モデル

## 1. 基本方針

GitHub を Meguribi の正本として扱います。

- Issue: 仮説、課題、要件、実装依頼、測定結果
- Issue コメント: AI の分析、計画、判断材料
- ラベル: Issue の種類、承認、実行状態
- ブランチ / worktree: 実装中の隔離環境
- Draft Pull Request: 実装成果物とレビュー待ち状態
- GitHub Actions: リモート上の正式な検証結果

Meguribi 固有の DB に GitHub の状態を複製しません。ローカル Run 情報は再実行やログ確認のためだけに持ちます。

## 2. Issue 種別

### `type:hypothesis`

仮説を検証するための Issue です。

必須項目:

```markdown
## 観測

## 課題候補

## 原因仮説

## 解決仮説

## 反対仮説

## 検証方法

## 成功条件

## 失敗・棄却条件
```

### `type:problem`

検証によって確認された課題を記録します。

必須項目:

```markdown
## 課題

## 対象ユーザー

## 根拠

## ユーザーへの影響

## 現在の回避方法

## 未確認事項

## 関連 Hypothesis
```

### `type:feature`

実装可能な要件を持つ新機能・改善 Issue です。

必須項目:

```markdown
## 解決する課題

## 対象ユーザー

## 要件

## 完了条件

## 対象外

## 成功指標

## ガードレール

## 関連 Issue
```

### `type:bug`

期待される振る舞いと実際の振る舞いの差を記録します。

必須項目:

```markdown
## 現象

## 期待する結果

## 実際の結果

## 再現手順

## 影響範囲

## 完了条件
```

### `type:measurement`

リリース後の評価を記録します。

必須項目:

```markdown
## 元の仮説

## 対象リリース

## 確認期間

## 指標

## 定性的反応

## 結果

## 判断
```

## 3. ラベル

最初から細かい状態ラベルを増やしすぎません。

### 種類

- `type:hypothesis`
- `type:problem`
- `type:feature`
- `type:bug`
- `type:measurement`
- `type:tech-debt`
- `type:docs`

### Product 状態

- `product:discovery`
- `product:validated`
- `product:rejected`
- `product:inconclusive`
- `product:approved`

### Agent 状態

- `agent:ready`
- `agent:running`
- `agent:review`
- `agent:blocked`

### リスク

- `risk:low`
- `risk:medium`
- `risk:high`

ラベルが存在しない場合、`meguribi init` が作成候補を表示します。MVP では利用者の確認なしにラベルを作成しません。

## 4. 承認ルール

### 新機能

`type:feature` は、原則として次の両方が必要です。

- `product:approved`
- `agent:ready`

### バグ、ドキュメント、テスト追加

低リスクの場合は `agent:ready` のみで実行可能です。

### 高リスク

次の変更はラベルに関係なく実行前に対話確認を要求します。

- DB スキーマ・マイグレーション
- 認証・認可
- 課金・契約
- 個人情報
- データ削除
- CI / デプロイ・本番設定
- `.github/workflows` の変更
- 依存関係の大規模更新

非対話モードでは、高リスク変更を `blocked` として停止します。

## 5. AI コメントの形式

同じコマンドを再実行したときにコメントを重複投稿しないよう、安定した HTML マーカーを使います。

```markdown
<!-- meguribi:hypothesis-review -->
## Meguribi Hypothesis Review
...
```

```markdown
<!-- meguribi:implementation-plan -->
## Meguribi Implementation Plan
...
```

```markdown
<!-- meguribi:code-review -->
## Meguribi Code Review
...
```

Meguribi は既存コメントを検索し、自分が作成したマーカー付きコメントだけを更新します。人間のコメントを書き換えません。

## 6. ブランチと worktree

### ブランチ名

```text
meguribi/issue-<number>-<slug>
```

例:

```text
meguribi/issue-373-owner-leave-guard
```

### worktree

```text
~/.local/share/meguribi/worktrees/<owner>/<repo>/issue-<number>/
```

作成条件:

- ローカルリポジトリの remote が対象 GitHub リポジトリと一致する。
- 基準ブランチを fetch できる。
- 同名ブランチ・worktree が競合していない。
- 既存 Run の lock がない。

既存ブランチがある場合は勝手に削除せず、`resume` または明示的 cleanup を要求します。

## 7. Commit

Meguribi が commit する場合、原則として Run ごとに 1 commit にまとめます。

例:

```text
feat: add quick transaction entry

Refs #125
```

自動 commit は設定で無効化できます。署名付き commit を必須にするリポジトリでは、利用者の Git 設定を尊重し、署名失敗時に停止します。

## 8. Pull Request

### Draft が標準

Meguribi が作る PR は必ず Draft から開始します。

### PR タイトル

Issue の種類と変更内容から簡潔に生成します。

```text
feat: 金額のみで支出を仮登録できるようにする
```

### PR 本文

```markdown
Closes #125

## 解決する課題

## 仮説

## 変更内容

## 対象外

## 検証結果

## Codex review

## リスクと確認事項

## 効果測定

## Meguribi metadata
```

`Closes #125` は、PR がデフォルトブランチを対象にする場合にだけ自動クローズへ利用します。別のベースブランチを使う場合は通常リンクに切り替えます。

### PR 更新

同じ Issue に対応する Draft PR が既に存在する場合、原則として新しい PR を作らず、既存 PR を更新します。

識別優先順位:

1. state.json の PR 番号
2. head branch
3. PR 本文の Meguribi metadata

## 9. CI

ローカル検証と GitHub Actions は役割が異なります。

- ローカル検証: PR 作成前の早期フィードバック
- GitHub Actions: リモート上の正式な必須チェック

このリポジトリの `CI` ワークフローは、Pull Request と push のたびに
`experiments/devin-acp` を Node.js 24 / pnpm 11.1.2 で検証します。依存関係は
`pnpm install --frozen-lockfile` で再現し、次の順序で全て成功することを必須にします。

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build`
5. `pnpm smoke -- --fake`

実機の Devin 認証や外部 MCP へ接続する smoke は CI では実行しません。CI は最小権限で実行し、同じ Pull Request / branch の古い実行は新しい実行へ置き換えます。

Meguribi は CI 完了を待つオプションを提供しますが、自動マージは行いません。

```bash
meguribi run owner/repo#125 --wait-checks
```

CI が失敗した場合:

1. 失敗チェックと取得可能なログを保存する。
2. Codex に原因分析を依頼できる。
3. 自動修正は最大回数以内かつ人間許可時だけ行う。
4. PR を ready にせず、`agent:blocked` または `agent:review` にする。

## 10. 人間の操作

標準フローで人間が行う操作:

1. 仮説・課題・要件の採用判断
2. `product:approved` / `agent:ready` の付与
3. Draft PR の確認
4. Draft 解除
5. マージ
6. リリース後の評価

Meguribi は、マージや本番デプロイを実行しません。

## 11. Cleanup

PR がマージまたはクローズされた後に、次を削除できます。

- ローカル worktree
- ローカル branch（マージ済みのみ、明示オプション時）
- remote branch（既定では削除しない）
- 一時ログ（保持期間経過後）

```bash
meguribi cleanup owner/repo#125
```

Run の監査情報は、設定した保持期間までは削除しません。

## 12. GitHub 権限

MVP で必要な操作:

- repository metadata read
- issues read/write
- pull requests read/write
- contents read/write または Git push
- actions status read

リポジトリ設定変更、secret 管理、環境承認、マージ権限は Meguribi に与えない運用を推奨します。
