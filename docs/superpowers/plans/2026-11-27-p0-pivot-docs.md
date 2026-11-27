# P0 方針転換の明文化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 旧前提（汎用ワークフローエンジン禁止・エージェント間の直接会話禁止・計画/レビューは Codex 固定・MVP に Web UI なし）を撤回し、設計書どおりの新方針をリポジトリの正本ドキュメントへ日英同時に反映する。

**Architecture:** ドキュメントのみの変更。コード・テスト・設定は触らない。`AGENTS.md` §5 により Readiness Gate と TDD は省略し、外部入力の隔離・差分確認・リンク/識別子/日英同期の確認を行う。

**Tech Stack:** Markdown のみ。

**Spec:** `docs/superpowers/specs/2026-11-27-multi-agent-orchestration-design.md`

## Global Constraints

- 日本語版が正本。英語版は同じ PR で意味を一致させる（`AGENTS.md` §2・§14）。
- 識別子・コマンド名・設定キー・ファイルパスは英語のまま両言語で一致させる。
- 新しい識別子は設計書のものを使う: `discuss`, `approve`, `specify`, `plan`, `implement`, `fix`, `verify`, `review`, `publish`, `agents`, `roles`, `discussants`, `summarizer`, `specifier`, `planner`, `implementer`, `reviewer`, `allowSameImplementerReviewer`, `events.jsonl`, `inbox/`, `meguribi workflow`, `meguribi discuss`, `meguribi approve`, `meguribi reject`, `meguribi desk`, `meguribi status`, `--follow`, `--agent`, `--log stream|compact|none`, `formatLiveLogEvent`, `step.progress`, `AgentActivity`。
- 維持する安全ルール（設計書 §7）を弱める記述を入れない。
- 未実装の機能は「計画中（P1〜P5）」と明記し、実装済みであるかのように書かない。

## Review Focus

- 旧前提の文言が一部のファイルにだけ残り、ドキュメント間で矛盾する → Task 4 の grep で 0 件を確認する。
- 日本語だけ更新して英語版が古いまま → 各タスクで ja/en を同じコミットに入れる。
- 「直接会話を許可」が実装工程にまで及ぶと読める → 議論工程は read-only、コード変更は承認後のみ、と必ず併記する。
- Web UI の解禁が「リモート公開・認証付き運用」まで許すと読める → localhost 専用・認証なし・常駐なしを併記する。
- 未実装コマンドを README の CLI status に「実装済み」として載せる → 計画中として別記する。

---

### Task 1: AGENTS.md とロール・スキルの改訂

**Files:**
- Modify: `AGENTS.md`（§1 26行目付近、§6 132・134行目付近、§10、Cursor Cloud 節 297行目付近とその直後の「実装済みは `doctor` のみ」の記述）
- Modify: `.agents/roles/tech-lead.md:51,67`
- Modify: `.agents/roles/product-lead.md:46`
- Modify: `.agents/skills/meguribi-core/SKILL.md:56`

- [ ] **Step 1: §1 を書き換える**
  「汎用ワークフローエンジン」を禁止リストから外す。代わりに「工程種別が閉じた宣言的ワークフロー（任意コード実行なし・逐次と上限付きループのみ）を持つ」と書く。ホステッド・マルチテナント・常駐デーモン・汎用エージェントフレームワークの禁止は残す。

- [ ] **Step 2: §6 を書き換える**
  - 132行目: Web UI を禁止リストから外し、「localhost 専用・認証なし・利用者が起動したときだけ動くローカル Web UI（Command Desk）は可」とする。DB・メッセージキュー・常駐サーバー・プラグインマーケット・クラウドコントロールプレーンの禁止は残す。
  - 134行目: 「議論工程（`discuss`）ではエージェントの発言を加工せず他エージェントへ渡してよい。議論工程は全員 read-only とし、結論は人間の承認（`approve`）を経てからだけ仕様・コードへ反映する。議論工程以外のエージェント間連携は、従来どおり Meguribi 所有の構造化成果物を介す」に置き換える。

- [ ] **Step 3: §10 を役割ベースに書き換える**
  「Codex」「Devin」の見出しを「役割と担当」に変え、設計書 §6.1 の役割と権限の表（`discussant` / `summarizer` / `specifier` / `planner` / `implementer` / `reviewer`）を載せる。commit / push / PR / Issue 更新 / リポジトリ設定変更をどのエージェントにも担当させない、という禁止はそのまま残す。`implementer` と `reviewer` は既定で別エージェントとする旨を書く。

- [ ] **Step 4: Cursor Cloud 節の古い記述を直す**
  「常駐サーバー、DB、Web UI は無く」を「常駐サーバーと DB は無い。Web UI（`apps/web`）は起動時のみのローカルサーバー」に直す。「実装済みのコマンドは `doctor` のみ」を README の CLI status と同じ一覧に直す。

- [ ] **Step 5: ロールとスキルを合わせる**
  `tech-lead.md:51` を Step 2 の新ルールの要約に、`tech-lead.md:67` と `product-lead.md:46` と `meguribi-core/SKILL.md:56` から「Web UI」「汎用ワークフロー基盤」を外す（DB・daemon・queue・cloud service は残す）。

- [ ] **Step 6: 差分を確認して commit**

Run: `git diff --stat && git diff AGENTS.md .agents`
Expected: 上記ファイルのみが変更され、§7（技術選定）・§9（Git）・§11（安全ルール）に変更がない。

```bash
git add AGENTS.md .agents/roles/tech-lead.md .agents/roles/product-lead.md .agents/skills/meguribi-core/SKILL.md
git commit -m "docs: AGENTS.mdとロールをマルチエージェント方針へ改訂"
```

### Task 2: プロダクト・アーキテクチャ文書（日英）の改訂

**Files:**
- Modify: `docs/ja/product-and-workflow.md`（§6 179行目付近、254行目付近「常駐 Web サーバー」の非対象リスト）と `docs/en/product-and-workflow.md` の対応箇所
- Modify: `docs/ja/architecture.md`（17行目付近、105行目付近の「汎用ワークフローエンジンは作らず」とその直後の `runDelivery` 例）と `docs/en/architecture.md` の対応箇所
- Modify: `docs/ja/artifacts-and-schemas.md` §1（5行目付近）と `docs/en/artifacts-and-schemas.md` の対応箇所

- [ ] **Step 1: product-and-workflow を改訂**
  設計書 §5 の全体像の図と、議論 → 承認 → 仕様化 → 計画 → 実装 → 検証 → レビュー ⇄ 修正 → Draft PR の流れを追加する。人間の介入点に「議論結論の承認（`approve`）」を追加する（§7 相当の節）。179行目は Task 1 Step 2 の新ルールに合わせる。254行目の非対象から「常駐 Web サーバー」は残し、「ローカル Web UI は対象（localhost 専用）」と補足する。

- [ ] **Step 2: architecture を改訂**
  17行目から Web UI を外す。105行目付近を「工程種別が閉じた YAML ワークフローを逐次実行するエンジンを持つ。既存 delivery は組み込みワークフロー `delivery` として移植する（P2・計画中）」に置き換え、設計書 §6.5 の工程種別・制御（`goto`/`max`・`then`・`of`）・静的検査ルールを要約する。アダプター一覧に `RoleAgent` / `RoleSession`（設計書 §6.1）を追加する。

- [ ] **Step 3: artifacts-and-schemas を改訂**
  §1 を「議論工程に限り、発言（`message`）を加工せず他エージェントへ渡す。それ以外の受け渡しは構造化成果物を境界にする」に置き換える。成果物一覧に `discussion/transcript.jsonl`、`discussion/conclusion.json`（`DiscussionConclusion`）、`approval.json`、`steps/<stepId>.json`、`events.jsonl`（`step.progress` と `agent.event` を含む）を「計画中（P2/P3）」として追加し、`DiscussionConclusion` と発言の封筒形式は設計書 §6.2 の定義を転記する。

- [ ] **Step 4: 英語版を同じ意味に揃えて commit**

Run: `git diff --stat docs/`
Expected: ja と en の同名ファイルが対になって変更されている（6ファイル）。

```bash
git add docs/ja/product-and-workflow.md docs/en/product-and-workflow.md docs/ja/architecture.md docs/en/architecture.md docs/ja/artifacts-and-schemas.md docs/en/artifacts-and-schemas.md
git commit -m "docs: ワークフローエンジンと議論工程をアーキテクチャ文書へ反映"
```

### Task 3: セキュリティ・ロードマップ・README（日英）の改訂

**Files:**
- Modify: `docs/ja/security-and-operations.md` と `docs/en/security-and-operations.md`
- Modify: `docs/ja/implementation-roadmap.md` と `docs/en/implementation-roadmap.md`
- Modify: `README.md`（Intended shape、Design constraints、CLI status）

- [ ] **Step 1: security-and-operations に議論工程の安全策を追加**
  設計書 §6.2 の上限（`maxTurns` 既定 20、`maxDurationMs` 既定 30 分、1ターン 5 分のタイムアウトが同じ参加者で2回連続で終了）、議論工程は全員 read-only、外部入力の区切りタグ、§6.3 の承認ハッシュ照合と自動承認なし、§6.1 の implementer ≠ reviewer を追加する。

- [ ] **Step 2: implementation-roadmap にフェーズ P1〜P5 を追加**
  設計書 §8 の表（フェーズ・内容・完了の目安）を転記する。既存フェーズの記述は変えない。

- [ ] **Step 3: README を改訂**
  Intended shape の図に議論ルームと役割割り当てを足す。Design constraints の「No database, web UI, queue...」を「No database, queue, or multi-tenant architecture. The local web UI is localhost-only and runs only when started.」に変え、日本語の対応文も直す。CLI status の後に「Planned (P1–P5): `workflow`, `discuss`, `approve`, `reject`, `desk`, `status`」を足し、実行中のエージェントの発言・ツール実行・結果が CLI と Command Desk にライブログとして流れ、エージェントごとの画面（Command Desk のペイン、ターミナルでは `status --follow --agent`）で追えるようになる予定であることを1文で書く。

- [ ] **Step 4: commit**

```bash
git add docs/ja/security-and-operations.md docs/en/security-and-operations.md docs/ja/implementation-roadmap.md docs/en/implementation-roadmap.md README.md
git commit -m "docs: 議論工程の安全策とP1〜P5ロードマップを追加"
```

### Task 4: 整合性の確認

**Files:** なし（確認のみ。問題があれば該当タスクのファイルを修正して追加 commit）

- [ ] **Step 1: 旧前提の残りを探す**

Run: `grep -rn "汎用ワークフローエンジンは作らず\|直接再帰的に会話\|自然文チャットを直接転送しません\|直接会話させない\|実装済みのコマンドは .doctor. のみ" AGENTS.md README.md docs .agents`
Expected: 出力なし。

Run: `grep -rni "general-purpose workflow engine\|do not converse directly\|no database, web UI" README.md docs/en`
Expected: 出力なし（英語版の旧文言が残っていない）。

- [ ] **Step 2: 日英の見出し構成を比べる**

Run: `for f in product-and-workflow architecture artifacts-and-schemas security-and-operations implementation-roadmap; do diff <(grep -c '^#' docs/ja/$f.md) <(grep -c '^#' docs/en/$f.md) >/dev/null || echo "heading count differs: $f"; done`
Expected: 出力なし。

- [ ] **Step 3: lint（Markdown は対象外だが既存の検査が壊れていないことの確認）**

Run: `pnpm lint`
Expected: exit code 0。

- [ ] **Step 4: Draft PR を作る**
  PR 本文は日本語。設計書へのリンク、Readiness Gate と TDD を省略した理由（ドキュメントのみ）、Task 4 の確認結果を載せる。
