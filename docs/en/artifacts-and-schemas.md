# Artifacts, State, and Schemas

## 1. Purpose

Meguribi does not forward free-form chat directly between Codex and Devin. Structured artifacts are the handoff boundary.

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

This provides responsibility separation, schema validation, reproducibility, human-summary regeneration, idempotent GitHub comments, and input lineage.

## 2. Run directory

```text
~/.local/share/meguribi/runs/
  `-- owner/repo/
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
              `-- lock
```

The Run ID contains a timestamp and random suffix so repeated execution of the same Issue is distinguishable.

## 3. Common metadata

Every JSON artifact includes common metadata:

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

Secrets, authentication values, and complete environment dumps are never stored.

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

State updates use atomic write-and-rename.

## 5. `context-manifest.json`

Track exactly which Issue state, comments, files, configuration, and commit were provided to an agent.

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
    }
  ],
  "repositoryHead": "abc123"
}
```

If an input changes before resume, Meguribi requires replanning or human confirmation.

## 6. `hypothesis.json`

```json
{
  "schemaVersion": 1,
  "artifactType": "hypothesis",
  "observations": [
    {
      "statement": "25% of users who opened the form did not finish",
      "source": "analytics-report.md",
      "confidence": "confirmed"
    }
  ],
  "problemCandidates": [
    {
      "statement": "Some lightweight users cannot complete registration",
      "targetUser": "users without an established entry habit",
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

Every observation requires a source and confidence classification.

## 7. `requirements.json`

```json
{
  "schemaVersion": 1,
  "artifactType": "requirements",
  "problem": "Category selection prevents some users from completing entry",
  "targetUsers": ["lightweight users"],
  "requirements": [
    {
      "id": "REQ-1",
      "statement": "An expense can be provisionally saved with only an amount",
      "priority": "must"
    }
  ],
  "acceptanceCriteria": [
    {
      "id": "AC-1",
      "statement": "The expense is saved after an amount is entered",
      "mapsTo": ["REQ-1"]
    }
  ],
  "outOfScope": ["AI category prediction", "receipt OCR"],
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
  "summary": "Add amount-only provisional expense entry",
  "requirements": ["Allow provisional entry with amount only"],
  "acceptanceCriteria": ["Existing verification commands succeed"],
  "outOfScope": ["Release configuration changes"],
  "proposedFiles": ["src/domain/transaction.ts"],
  "steps": ["Update the domain model", "Add tests"],
  "tests": ["Domain unit test"],
  "risks": ["Compatibility with existing callers"],
  "humanDecisions": ["Release timing"],
  "unresolvedItems": []
}
```

The `plan.json` content requires `summary`, `requirements`, `acceptanceCriteria`, `outOfScope`, `proposedFiles`, `steps`, `risks`, `tests`, `humanDecisions`, and `unresolvedItems`. `metadata.eventLog` contains only redacted, JSON-safe events.

### 8.1 `plan.json` validation

Codex responses are validated by both a runtime schema and a JSON Schema rather than by treating natural language as evidence of success. Unknown fields, missing required fields, and invalid JSON may be repaired once; a second invalid response stops the Run.

## 9. `implementation-result.json`

Meguribi creates this from Devin output plus actual Git and process state.

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

`git status` is authoritative for changed files.

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
  "summary": "Core requirements are covered, but concurrency control is missing",
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

Planning verifies the Issue digest before execution. Review verifies canonical JSON digests for the Issue, plan, diff, and verification input; a mismatch stops execution before Codex is started.

Status values:

- `approved`
- `approved_with_notes`
- `changes_required`
- `blocked`

Codex review assists but does not replace human review.

## 12. `measurement.json`

```json
{
  "schemaVersion": 1,
  "artifactType": "measurement",
  "originalHypothesis": "Amount-only entry improves completion rate",
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

## 13. Schema management

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

- Valibot schemas are the code source of truth.
- Codex JSON Schemas are generated during build.
- `schemaVersion` is required.
- Breaking changes require migration or an explicit incompatibility error.
- Invalid agent output receives at most one schema-repair attempt before the Run stops.

## 14. Logging

Store:

- Executable and non-secret arguments
- Start and end time
- Exit code
- Agent event logs
- Verification logs
- Git diff
- GitHub update result

Do not store:

- API keys or OAuth tokens
- Complete environment variables
- `.env` contents
- Authentication files
- Private agent reasoning

## 15. Retention

Suggested defaults:

- Successful Run: 30 days
- Failed Run: 60 days
- Diff, review, and state may be retained until manual deletion
- Worktree is removed after PR merge or close through cleanup

Retention is user-configurable.

## 16. Agent event and error contracts

To abstract external agents such as the Codex SDK and Devin ACP, domain types live in `@meguribi/core` and Valibot schemas live in `@meguribi/schemas`.

### AgentEvent

A discriminated union identified by the `type` field.

| type | description | main fields |
| --- | --- | --- |
| `session.started` | session started | `sessionId`, `at` |
| `message.delta` | text stream chunk | `sessionId`, `text`, `at` |
| `tool.started` | tool execution started | `sessionId`, `tool`, `toolCallId?`, `summary?`, `at` |
| `tool.completed` | tool execution completed | `sessionId`, `tool`, `toolCallId?`, `exitCode?`, `status?`, `at` |
| `file.changed` | file changed | `sessionId`, `path`, `at` |
| `approval.required` | human approval requested | `sessionId`, `requestId`, `summary`, `at` |
| `turn.completed` | one turn completed | `sessionId`, `stopReason?`, `at` |
| `session.failed` | session failed | `sessionId`, `error`, `at` |
| `unknown` | unrecognized raw event | `sessionId`, `rawType`, `at` |

`at` is an ISO 8601 timestamp string.

Raw events from Devin ACP and similar sources are normalized inside each adapter. The adapter stores the redacted raw payload as JSONL / artifact and returns only normalized `AgentEvent` values to the core. This prevents vendor-specific information from leaking into the core contract.

### AgentError

| code | description |
| --- | --- |
| `executable_not_found` | executable not found |
| `unsupported_version` | unsupported version |
| `unauthenticated` | not authenticated |
| `protocol_initialization_failure` | protocol initialization failed |
| `protocol_violation` | protocol violation detected |
| `malformed_message` | malformed message received |
| `permission_denied` | execution denied |
| `timeout` | operation timed out |
| `cancelled` | cancelled |
| `process_crashed` | child process crashed |
| `unsupported_signal` | an unsupported signal was requested |
| `cleanup_failed` | cleanup failed |
| `policy_blocked` | blocked by policy |
| `unknown` | unexpected error |

`isRetryable` is a flag indicating whether the same input may be retried.

### DevinDiagnosis

Result of Devin CLI diagnosis used by `meguribi doctor` and `run` preflight. Types live in `@meguribi/core`; Valibot schemas live in `@meguribi/schemas`.

| Field | Description |
| --- | --- |
| `executable` | `{ status: "ok" \| "missing"; path? }` |
| `version` | `{ status: "supported" \| "unsupported" \| "unknown"; raw? }` |
| `authentication` | `{ status: "authenticated" \| "unauthenticated" \| "unknown" }` |
| `acp` | `{ status: "supported" \| "unsupported" \| "unknown" }` |
| `inheritedMcpPolicy` | `"allow" \| "warn" \| "deny"` |
| `runnable` | overall readiness decision |
| `warnings` | `DiagnosisWarning[]` (e.g. `inherited_mcp`, `unknown_version`) |
| `errors` | `DiagnosisError[]` |

`DiagnosisError.code` extends `AgentErrorCode` with `capability_missing` for absent ACP support. Fields must not retain raw credentials, MCP URLs, or tokens.

## 17. ManagedProcess startup and failure contract

`ProcessRunner.run()` in `@meguribi/process` returns a `ManagedProcess` synchronously. Child-process startup may still be pending when the object is returned.

| Item | Contract |
| --- | --- |
| `pid` | A `number` after a successful spawn and `undefined` after a spawn failure. Its type is `number | undefined`. |
| `startedAt` | An ISO 8601 timestamp captured when `run()` is called. |
| `waitForExit()` | Resolves with the exit result after spawn completion, or rejects with the classified `ProcessError` on spawn failure. |
| `terminateTree()` / `signal()` / `writeStdin()` / `closeStdin()` | Wait for spawn completion. On a spawn failure, they reject with the same `ProcessError` instance as `waitForExit()`. |

Callers must not treat the presence of `pid` as proof of successful startup. They must await an operation promise and handle either its result or classified error. Spawn failures return `executable_not_found`, `permission_denied`, or `process_crashed`. `ProcessExit` is returned only for a successfully started and terminated process, and includes start and finish timestamps, exit code, and signal.
