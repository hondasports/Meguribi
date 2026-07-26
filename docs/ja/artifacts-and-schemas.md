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
              +-- prompt.json          # prompt version / hash
              +-- git-boundary.json    # Git/worktree safety result
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
  "metadata": {
    "schemaVersion": 1,
    "artifactId": "artifact-plan-1",
    "createdAt": "2026-07-26T00:00:00Z",
    "durationMs": 1200,
    "producer": {
      "kind": "codex",
      "role": "planner",
      "threadId": "thread-plan-1"
    },
    "sourceDigests": { "issue": "sha256:...", "repository": "sha256:..." },
    "eventLog": []
  },
  "summary": "金額のみの支出仮登録を追加する",
  "requirements": ["支出を金額だけで仮登録できる"],
  "acceptanceCriteria": ["既存の検証コマンドが成功する"],
  "outOfScope": ["リリース設定の変更"],
  "proposedFiles": ["src/domain/transaction.ts"],
  "steps": ["ドメインモデルを変更する", "テストを追加する"],
  "tests": ["ドメインの unit test"],
  "risks": ["既存 caller との互換性"],
  "humanDecisions": ["リリース時期"],
  "unresolvedItems": []
}
```

`plan.json` の content は `summary`、`requirements`、`acceptanceCriteria`、`outOfScope`、`proposedFiles`、`steps`、`risks`、`tests`、`humanDecisions`、`unresolvedItems` を必須とします。`metadata.eventLog` は redaction 済みの JSON-safe event だけを保存します。

### 8.1 `plan.json` の validation

Codex の応答は自然文を成功根拠にせず、runtime schema と JSON Schema の両方で検証します。未知フィールド、必須フィールド欠落、不正 JSON は最大1回だけ repair を許可し、再度不正なら Run を停止します。

## 9. `implementation-result.json`

Devin の自然文回答をそのまま正本にせず、Meguribi が Git とプロセス結果を組み合わせて生成します。`DevinAcpAdapter` はドメイン型 `ImplementationResult` を返し、RunStore へ保存します。

```json
{
  "status": "completed",
  "sessionId": "session-devin",
  "startedAt": "2026-07-26T12:00:00Z",
  "finishedAt": "2026-07-26T12:05:00Z",
  "durationMs": 300000,
  "stopReason": "end_turn",
  "changedFiles": [
    "src/domain/transaction.ts",
    "src/domain/transaction.test.ts"
  ],
  "reportedFiles": ["src/domain/transaction.ts"],
  "unresolvedItems": [],
  "permissionDecisions": [],
  "publishable": true,
  "artifactPaths": {
    "root": "/path/to/run/devin-artifacts"
  }
}
```

`changedFiles` は Git / worktree 境界検証を正本にします。`reportedFiles` は参考情報です。`publishable` が false、または status が `completed` 以外の場合、delivery workflow の publish gate は commit / push / Draft PR へ進みません。

実装 prompt の `FixContext` は、前回試行と fix instruction の出典付き内容をどちらも untrusted block として扱います。`git-boundary.json` の `warnings` には、Devin の `reportedFiles` と Git diff の不一致など、公開を止めない参考情報を保存します。

## 10. `verification.json`

```json
{
  "schemaVersion": 1,
  "artifactType": "verification",
  "success": true,
  "commands": [
    {
      "name": "test",
      "exitCode": 0,
      "startedAt": "...",
      "finishedAt": "...",
      "logPath": "logs/verify-test.log",
      "timedOut": false
    }
  ]
}
```

`timedOut` は任意です。コマンドが per-command timeout を超えた場合に `true` となり、そのときの `exitCode` は `null`、全体の `success` は `false` です。

`logPath` は RunStore 配下の検証ログを指します。stdout と stderr は区切り付きで保存し、保存前に secret-like な値を redaction します。ログはコマンドごとに上限を設け、超過時は truncation marker を記録します。

## 11. `review.json`

```json
{
  "schemaVersion": 1,
  "artifactType": "code-review",
  "metadata": {
    "schemaVersion": 1,
    "artifactId": "artifact-review-1",
    "createdAt": "2026-07-26T00:00:00Z",
    "durationMs": 900,
    "producer": {
      "kind": "codex",
      "role": "reviewer",
      "threadId": "thread-review-1"
    },
    "sourceDigests": { "issue": "sha256:...", "plan": "sha256:...", "diff": "sha256:...", "verification": "sha256:..." },
    "eventLog": []
  },
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

planning は Issue の digest、review は Issue、plan、diff、verification の canonical JSON digest を実行前に検証します。不一致の場合は Codex を起動せず停止します。

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

- Valibot をコード上の正本とする。
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

未知の `sessionUpdate` は握りつぶさず `type: "unknown"` として保持する。`unknown` だけでは workflow の状態を進めてはならない。

### Devin agent artifact レイアウト

RunStore 導入前も含め、Devin ACP session の成果物は次の配置を標準とする。

```text
<artifactRoot>/   # 将来: runs/<run-id>/agents/devin/
├── raw-events.jsonl   # redaction 後の raw payload（sequence 付き）
├── events.jsonl       # 正規化 AgentEvent（同一 sequence で対応付け）
├── stderr.log         # 診断用 stderr（redaction 後）
├── session.json       # sessionId / protocolVersion / stopReason など
├── devin-prompt.md    # redaction 後の送信 prompt
├── prompt.json        # prompt version / hash
├── git-boundary.json  # Git/worktree safety result
├── result.json        # 最小の実行結果サマリ
└── termination.json    # shutdown の段階結果と残留 process
```

JSONL の各行は次の envelope を持つ。

- raw: `{ sequence, at, kind, raw }`
- normalized: `{ sequence, at, event }`

永続化前に secret redaction を必ず通す。redaction または書き込みに失敗した場合は保存を中止する（fail-closed）。

`termination.json` は `reason`、`stopReason`、`stdinClosed`、`cancelSent`、`gracefulExit`、`terminateSent`、`forceKillUsed`、`residualProcesses`、および分類済み `cleanupError` を保存します。残留 process が 0 と確認できない場合、実行を成功扱いにしません。

### Devin ACP compatibility smoke 結果

`experiments/devin-acp` の手動 smoke は `artifacts/devin-acp/<run-id>/compatibility-result.json` に machine-readable な結果を保存します。`artifactType` は `devin-acp-compatibility-smoke`、`schemaVersion` は `1` です。

```json
{
  "schemaVersion": 1,
  "artifactType": "devin-acp-compatibility-smoke",
  "optIn": true,
  "cliVersion": "3000.0.0-fake",
  "acpCompatible": true,
  "sessionStarted": true,
  "promptCompleted": true,
  "worktreeBoundaryOk": true,
  "shutdownCompleted": true,
  "status": "completed",
  "warnings": [],
  "changedFiles": ["README.md"],
  "outsideChanges": [],
  "residualProcesses": false,
  "artifactDirectory": "artifacts/devin-acp/<run-id>",
  "implementation": { ... }
}
```

主要フィールド:

- `optIn`: 実 Devin 起動の明示 opt-in があったか。
- `cliVersion`: 診断または fake 実行で確認した Devin CLI version。
- `acpCompatible`: ACP lifecycle、worktree 境界、shutdown、残留 process をすべて満たしたか。
- `sessionStarted` / `promptCompleted` / `worktreeBoundaryOk` / `shutdownCompleted`: 各 gate の結果。
- `status`: `completed` / `blocked` / `failed`。
- `warnings`: MCP policy や adapter からの警告。
- `error`: 失敗時の理由。
- `changedFiles` / `outsideChanges`: Git authoritative changed files と worktree 外変更。
- `residualProcesses`: 子/孫 process の残留有無。
- `artifactDirectory`: 成果物保存先。
- `implementation`: 本番 `DevinAcpAdapter` から返された `ImplementationResult`（opt-in なし・blocked 時は `null`）。

secret、token、認証情報、全環境変数は含みません。partial/failure 時も `artifactDirectory`、`error`、`status` を保存し、成功扱いにしません。

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
