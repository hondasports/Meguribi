---
name: product-growth-loop
description: Meguribi の `discover`、`hypothesis`、`promote`、`explore`、`require`、`measure` と、観測から次の仮説までの Product/BIZ ループを実装する際に使用する。
---

# プロダクト成長ループスキル

## 使うタイミング

- 課題候補の抽出
- 原因仮説・解決仮説・反対仮説の生成
- Hypothesis Issue から Problem Issue への昇格
- 解決案比較と Requirement / Feature Issue 作成
- リリース後の Measurement Issue と次の仮説

## 先に読む

- `docs/ja/product-and-workflow.md`
- `docs/ja/github-workflow.md`
- `docs/ja/artifacts-and-schemas.md`
- `docs/ja/implementation-roadmap.md` の Phase 2

## 原則

- AI が作るのは課題候補・仮説候補・Issue 草案であり、事実の確定ではない。
- 観測事実、利用者の発言、推測、仮説、提案を明確に分ける。
- 一つの解決案へ誘導せず、反対仮説と代替案を出す。
- 昇格と採用は人間が判断する。
- Issue を自動で大量作成しない。
- 実装しやすさだけで優先順位を決めない。

## データモデル

最低限、次を区別します。

```text
Observation: 確認できた事実や入力
ProblemCandidate: 観測から導いた課題候補
CauseHypothesis: 原因に関する仮説
SolutionHypothesis: 解決方法と期待結果の仮説
CounterHypothesis: 反証・別原因・悪影響の仮説
Problem: 人間が採用した課題
Requirement: 採用した解決方針と完了条件
Measurement: リリース後の結果と判断材料
```

## `discover`

入力例:

- GitHub Issue / comment の期間・label 検索
- 利用者が指定した Markdown / JSON
- product docs
- 手動で入力された観測

出力:

- 重複テーマ
- 課題候補
- 根拠となる観測への参照
- 推測と不足情報
- impact / confidence / strategic fit の説明

件数や声量だけを重要度とみなしません。

## `hypothesis`

一つの課題候補から最低限次を生成します。

- 原因仮説
- 複数の解決仮説
- 反対仮説
- 実装しない検証方法
- 必要な追加証拠
- 成功条件
- 棄却条件
- guardrail

AI は入力にない利用者発言や数値を捏造してはいけません。

## `promote`

- validated evidence が存在するか確認する。
- 仮説と観測を混同していないか確認する。
- Problem Issue 草案を作成する。
- 元 Hypothesis Issue と根拠をリンクする。
- 人間承認なしに `status:confirmed` 相当へ変更しない。

## `explore`

複数解決案を次の軸で比較します。

- user value
- business / product value
- effort
- technical risk
- operational cost
- reversibility
- measurement difficulty
- guardrail risk

スコアは判断補助であり、自動採用根拠にしません。

## `require`

選ばれた解決案を次へ変換します。

- 解決する課題
- 対象利用者
- requirements
- acceptance criteria
- out of scope
- metrics
- guardrails
- rollout / rollback considerations
- related Hypothesis / Problem Issue

要件が曖昧な場合は、実装しやすい解釈で埋めず人間確認を要求します。

## `measure`

- 元仮説と success / rejection conditions を復元する。
- 実測値、定性反応、障害、guardrail を整理する。
- `scale`、`iterate`、`stop`、`inconclusive` の候補を出す。
- 結果と推測を分ける。
- 次の仮説候補を提示する。
- 最終判断は人間に残す。

## GitHub 上の追跡

```text
Hypothesis Issue
  -> Problem Issue
  -> Feature / Requirement Issue
  -> Pull Request
  -> Measurement Issue
  -> Next Hypothesis Issue
```

Issue 本文の関連リンクと stable marker を使用し、独自 DB を必須にしません。

## 人間ゲート

- 課題として採用する時
- 解決案を選ぶ時
- Requirement Issue を実装可能として承認する時
- リリース後の継続・改善・撤退を決める時

## テスト

- observation / inference separation
- evidence reference validation
- missing evidence
- multiple and counter hypotheses
- fabricated data rejection
- promotion without approval
- solution comparison without forced winner
- requirement completeness
- measurement classification
- link / marker generation
- duplicate Issue prevention

## 禁止事項

- 根拠のない事実・数値・利用者発言の生成
- AI による自動昇格・自動採用
- Issue の大量自動作成
- 一案だけを提示して比較を省略すること
- 測定なしで成功を断定すること

## 完了条件

- Hypothesis -> Problem -> Feature -> PR -> Measurement を追跡できる。
- 観測と推測を構造化して分離できる。
- 各昇格で人間承認を要求できる。
- 測定結果から次の仮説候補を作れる。
