# 成果物・状態・スキーマ

## 1. 目的

Codex と Devin の間で自然文チャットを直接転送しません。

Meguribi が管理する構造化成果物を受け渡しの境界にします。

```text
GitHub Issue
  -> hypothesis.json
  -> problem-draft.json
  -> requirements.json
  -> plan.json
  -> implementation-result.json
  -> verification.json
  -> review.json
  -> Pull Request
  -> measurement.json
```

構造化成果物によって、次を実現します。

- エージェントごとの責務分離
- 再実行可能性
- スキーマ検証
- 人間向け要約の再生成
- GitHub コメントの冪等更新
- どの入力から成果物が作られたかの追跡

## 2. Run ディレクトリ

```text
~/.local/share/meguribi/runs/
  `-- hondasports/kakeibo/
      `-- issue-125/
          `-- 20260725T120000Z-ab12cd/
              +-- state.json
              +-- resolved-config.json
              +-- issue.json
              +-- context-manifest.json
              +-- hypothesis.json
              +-- requirements.json
              +-- plan.json
              +-- devin-prompt.md
              +-- implementation-result.json
              +-- verification.json
              +-- diff.patch
              +-- review.json
              +-- pull-request.json
              +-- logs/
              |   +-- codex-plan.jsonl
              |   +-- devin.stdout.log
              |   +-- devin.stderr.log
              |   `-- verify-test.log
              `-- lock
```

Run ID は時刻とランダム値を含み、同一 Issue の再実行を区別します。

## 3. 共通メタデータ

各 JSON 成果物は共通メタデータを持ちます。

```json
{
  "schemaVersion": 1,
  "artifactType": "implementation-plan",
  "artifactId": "art_01J...",
  "runId": "20260725T120000Z-ab12cd",
  "repository": "owner/repo",
  "issueNumber": 125,
  "createdAt": "2026-07-25T12:00:00Z",
  "producer": {
    "kind": "codex",
    "role": "planner",
    "sessionId": "thread-id"
  },
  "sourceDigests": {
    "issue": "sha256:...",
    "repositoryHead": "git-sha",
    "config": "sha256:..."
  }
}
```

秘密情報、プロンプト内の認証値、全環境変数は保存しません。

## 4. `state.json`

```json
{
  "schemaVersion": 1,
  "runId": "20260725T120000Z-ab12cd",
  "repository": "owner/repo",
  "issueNumber": 125,
  "command": "run",
  "status": "reviewing",
  "completedSteps": [
    "context",
    "worktree",
    "planning",
    "implementation",
    "verification"
  ],
  "branch": "meguribi/issue-125-quick-entry",
  "worktreePath": "/home/user/.local/share/meguribi/worktrees/owner/repo/issue-125",
  "baseRef": "origin/main",
  "baseSha": "abc123",
  "headSha": "def456",
  "pullRequestNumber": null,
  "agentSessions": {
    "codexPlan": "thread-plan",
    "devinImplementation": "session-devin",
    "codexReview": "thread-review"
  },
  "createdAt": "2026-07-25T12:00:00Z",
  "updatedAt": "2026-07-25T12:30:00Z"
}
```

状態は atomic write で更新します。

## 5. `context-manifest.json`

エージェントへ渡した文脈を追跡します。

```json
{
  "issue": {
    "number": 125,
    "updatedAt": "2026-07-25T10:00:00Z",
    "digest": "sha256:..."
  },
  "comments": [
    {
      "id": 1001,
      "author": "user",
      "digest": "sha256:..."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "gitBlobSha": "..."
    },
    {
      "path": "docs/product/vision.md",
      "gitBlobSha": "..."
    }
  ],
  "repositoryHead": "abc123"
}
```

再開時に入力が変わっていた場合、古い成果物をそのまま使わず再計画または人間確認を要求します。

## 6. `hypothesis.json`

```json
{
  "schemaVersion": 1,
  "artifactType": "hypothesis",
  "observations": [
    {
      "statement": "入力画面を開いた利用者の25%が登録を完了していない",
      "source": "analytics-report.md",
      "confidence": "confirmed"
    }
  ],
  "problemCandidates": [
    {
      "statement": "一部のライトユーザーが支出登録を完了できていない",
      "targetUser": "入力習慣が未定着の利用者",
      "confidence": "medium"
    }
  ],
  "causeHypotheses": [],
  "solutionHypotheses": [],
  "counterHypotheses": [],
  "validationMethods": [],
  "successConditions": [],
  "rejectionConditions": [],
  "missingEvidence": []
}
```

観測には必ず出所と確度を持たせます。

## 7. `requirements.json`

```json
{
  "schemaVersion": 1,
  "artifactType": "requirements",
  "problem": "カテゴリ選択の負担で一部ユーザーが登録を完了できない",
  "targetUsers": ["ライトユーザー"],
  "requirements": [
    {
      "id": "REQ-1",
      "statement": "金額のみで支出を仮登録できる",
      "priority": "must"
    }
  ],
  "acceptanceCriteria": [
    {
      "id": "AC-1",
      "statement": "金額入力後に支出が保存される",
      "mapsTo": ["REQ-1"]
    }
  ],
  "outOfScope": ["AIカテゴリ推定", "レシートOCR"],
  "successMetrics": [],
  "guardrails": [],
  "openQuestions": [],
  "relatedIssues": {
    "hypothesis": [123],
    "problem": [124]
  }
}
```

## 8. `plan.json`

```json
{
  "schemaVersion": 1,
  "artifactType": "implementation-plan",
  "summary": "金額のみの支出仮登録を追加する",
  "assumptions": [],
  "affectedAreas": [
    {
      "area": "domain",
      "files": ["src/domain/transaction.ts"],
      "reason": "カテゴリ未指定状態を表現する"
    }
  ],
  "steps": [
    {
      "id": "STEP-1",
      "description": "ドメインモデルを変更する",
      "dependsOn": [],
      "mapsTo": ["REQ-1", "AC-1"]
    }
  ],
  "tests": [],
  "risks": [],
  "protectedPathRequests": [],
  "openQuestions": [],
  "recommendation": "proceed"
}
```

`recommendation`:

- `proceed`
- `needs_human_input`
- `blocked`

## 9. `implementation-result.json`

Devin の自然文回答をそのまま正本にせず、Meguribi が Git とプロセス結果を組み合わせて生成します。

```json
{
  "schemaVersion": 1,
  "artifactType": "implementation-result",
  "agentExitCode": 0,
  "changedFiles": [
    "src/domain/transaction.ts",
    "src/domain/transaction.test.ts"
  ],
  "agentSummary": "...",
  "reportedTests": ["pnpm test"],
  "unresolvedItems": [],
  "policyWarnings": []
}
```

`changedFiles` は `git status` を正本にします。

## 10. `verification.json`

```json
{
  "schemaVersion": 1,
  "artifactType": "verification",
  "success": true,
  "commands": [
    {
      "name": "test",
      "command": ["pnpm", "test"],
      "exitCode": 0,
      "durationMs": 12000,
      "stdoutLog": "logs/verify-test.log",
      "stderrLog": null
    }
  ],
  "startedAt": "...",
  "completedAt": "..."
}
```

## 11. `review.json`

```json
{
  "schemaVersion": 1,
  "artifactType": "code-review",
  "status": "changes_required",
  "summary": "主要要件は満たすが競合制御が不足している",
  "requirementCoverage": [
    {
      "requirementId": "REQ-1",
      "status": "covered",
      "evidence": ["src/domain/transaction.ts"]
    }
  ],
  "findings": [
    {
      "id": "FINDING-1",
      "severity": "high",
      "path": "src/domain/transaction.ts",
      "line": 80,
      "problem": "...",
      "requiredChange": "..."
    }
  ],
  "missingTests": [],
  "scopeViolations": [],
  "recommendedAction": "fix"
}
```

`status`:

- `approved`
- `approved_with_notes`
- `changes_required`
- `blocked`

Codex のレビューは補助判断です。人間の PR レビューを置き換えません。

## 12. `measurement.json`

```json
{
  "schemaVersion": 1,
  "artifactType": "measurement",
  "originalHypothesis": "金額のみで登録できれば完了率が改善する",
  "period": {
    "from": "2026-08-01",
    "to": "2026-08-14"
  },
  "metrics": [],
  "qualitativeEvidence": [],
  "result": "inconclusive",
  "recommendedNextAction": "collect_more_data",
  "nextHypothesisCandidates": []
}
```

## 13. スキーマ管理

```text
packages/schemas/
  +-- common.ts
  +-- hypothesis.ts
  +-- requirements.ts
  +-- plan.ts
  +-- implementation-result.ts
  +-- verification.ts
  +-- review.ts
  `-- measurement.ts
```

- Zod をコード上の正本とする。
- Codex 用 JSON Schema をビルド時に生成する。
- `schemaVersion` を必須にする。
- 破壊的変更時は migration または明示的な非互換エラーを用意する。
- 不正な Agent 出力は最大 1 回だけ修復プロンプトを送り、それでも不正なら停止する。

## 14. ログ

### 保存する

- 実行コマンド名と引数（秘密値を除く）
- 開始・終了時刻
- 終了コード
- Agent のイベントログ
- 検証ログ
- Git diff
- GitHub 更新結果

### 保存しない

- API key
- OAuth token
- 全環境変数
- `.env` 内容
- 認証ファイル内容
- Agent の非公開推論

## 15. 保持と削除

既定案:

- 成功 Run: 30 日
- 失敗 Run: 60 日
- diff / review / state: 手動削除まで保持可能
- worktree: PR merge / close 後に cleanup

保持期間はユーザー設定で変更可能にします。

## 16. Agent イベント・エラー共通契約

Codex SDK と Devin ACP などの外部エージェントを抽象化するため、`@meguribi/core` に Agent 用の型を定義し、`@meguribi/schemas` に Valibot スキーマを配置する。

### AgentEvent

`type` フィールドで判別される discriminated union である。

| type | 説明 | 主要フィールド |
| --- | --- | --- |
| `session.started` | セッション開始 | `sessionId`, `at` |
| `message.delta` | テキストストリームの chunk | `sessionId`, `text`, `at` |
| `tool.started` | ツール実行開始 | `sessionId`, `tool`, `toolCallId?`, `summary?`, `at` |
| `tool.completed` | ツール実行完了 | `sessionId`, `tool`, `toolCallId?`, `exitCode?`, `status?`, `at` |
| `file.changed` | ファイル変更 | `sessionId`, `path`, `at` |
| `approval.required` | 人間への承認要求 | `sessionId`, `requestId`, `summary`, `at` |
| `turn.completed` | 1 ターン完了 | `sessionId`, `stopReason?`, `at` |
| `session.failed` | セッション失敗 | `sessionId`, `error`, `at` |
| `unknown` | 未対応の raw イベント | `sessionId`, `rawType`, `at` |

`at` は ISO 8601 タイムスタンプ文字列とする。

Devin ACP などの raw イベントは、各 adapter 内で正規化される。adapter は redaction 後の raw payload を JSONL / artifact へ保存し、core には正規化済みの `AgentEvent` だけを返す。これにより vendor 固有の情報が core 契約に漏れない。

### AgentError

| code | 説明 |
| --- | --- |
| `executable_not_found` | 実行ファイルが見つからない |
| `unsupported_version` | サポート外のバージョン |
| `unauthenticated` | 認証されていない |
| `protocol_initialization_failure` | プロトコル初期化に失敗した |
| `protocol_violation` | プロトコル違反を検出した |
| `malformed_message` | 壊れたメッセージを受信した |
| `permission_denied` | 実行が拒否された |
| `timeout` | タイムアウトした |
| `cancelled` | キャンセルされた |
| `process_crashed` | 子プロセスが異常終了した |
| `unsupported_signal` | サポートされていないシグナルが指定された |
| `cleanup_failed` | cleanup に失敗した |
| `policy_blocked` | policy によりブロックされた |
| `unknown` | 想定外のエラー |

`isRetryable` は同じ入力でリトライ可能かを示すフラグとする。

### DevinDiagnosis

`meguribi doctor` と `run` preflight が返す Devin CLI 診断結果。`@meguribi/core` に型、`@meguribi/schemas` に Valibot スキーマを置く。

| フィールド | 説明 |
| --- | --- |
| `executable` | `{ status: "ok" \| "missing"; path? }` |
| `version` | `{ status: "supported" \| "unsupported" \| "unknown"; raw? }` |
| `authentication` | `{ status: "authenticated" \| "unauthenticated" \| "unknown" }` |
| `acp` | `{ status: "supported" \| "unsupported" \| "unknown" }` |
| `inheritedMcpPolicy` | `"allow" \| "warn" \| "deny"` |
| `runnable` | 実行してよいかの総合判定 |
| `warnings` | `DiagnosisWarning[]`（例: `inherited_mcp`, `unknown_version`） |
| `errors` | `DiagnosisError[]` |

`DiagnosisError.code` は `AgentErrorCode` に加え、ACP 欠如を表す `capability_missing` を含む。認証情報、MCP URL、token などの生値をフィールドへ残してはならない。

## 17. ManagedProcess の起動・失敗契約

`@meguribi/process` の `ProcessRunner.run()` は同期的に `ManagedProcess` を返す。返却時点では子プロセスの起動が保留中の場合がある。

| 項目 | 契約 |
| --- | --- |
| `pid` | spawn が成功した場合は `number`。spawn に失敗した場合は `undefined`。型は `number | undefined`。 |
| `startedAt` | `run()` 呼び出し時に記録する ISO 8601 タイムスタンプ。 |
| `waitForExit()` | spawn 完了または失敗後に終了結果を返す。spawn 失敗時は分類済みの `ProcessError` で reject する。 |
| `terminateTree()` / `signal()` / `writeStdin()` / `closeStdin()` | spawn 完了を待つ。spawn 失敗時は `waitForExit()` と同じ `ProcessError` インスタンスで reject する。 |

呼び出し側は `pid` の存在を起動成功の証拠として扱わず、操作の Promise を待って成功または分類済みエラーを処理する。spawn 失敗では、`executable_not_found`、`permission_denied`、または `process_crashed` が返る。`ProcessExit` は正常に起動・終了した process にだけ返り、開始・終了時刻、exit code、signal を含む。
