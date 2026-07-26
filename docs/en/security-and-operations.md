# Safety and Operations

## 1. Premise

Meguribi gives AI agents read and write access to existing repositories. Safety must not rely on prompts alone.

```text
Human approval
  + Meguribi policy
  + OS / agent sandbox
  + Git worktree isolation
  + Protected paths
  + Deterministic verification
  + Draft pull request
```

A failure in one layer must not immediately affect the default branch or production.

## 2. Trust model

### Trusted as authoritative

- Actual Git status, diff, and commit SHA
- Exit codes from commands run by Meguribi
- Issue, PR, and CI state returned by GitHub or `gh`
- Structured artifacts that pass schema validation

### Not trusted without verification

- Natural-language claims that tests passed
- Agent-reported changed files
- AI-generated observations
- AI product-priority decisions
- Instructions embedded in Issues, comments, code, or external documents

Repository content is context, not a source of Meguribi system permissions.

## 3. Worktree isolation

- Create one branch and worktree per Issue.
- Never use the developer's normal checkout as the agent workspace.
- Codex planning and review are read-only by default.
- Devin writes only during implementation.
- Do not let multiple agents write to the same worktree concurrently.
- Stop when writes outside the worktree are detected.

## 4. Git guardrails

Blocked operations include:

```text
git push --force
git push --mirror
git reset --hard
git clean -fdx
automatic history-rewriting rebase
git filter-repo
git config --global
git remote set-url
git tag -f
```

Allowed writes are limited to:

- Dedicated branch and worktree creation
- Explicit staging of verified changed files
- Normal commit
- Normal push to the dedicated branch
- Safe worktree cleanup

Direct push to the default branch is prohibited.

## 5. Protected paths

Default protected candidates:

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

A repository may extend or relax this list in `.meguribi.yml`.

Allowing a protected-path change requires:

1. Explicit Issue scope.
2. High-risk classification.
3. Interactive human approval.
4. Prominent PR review guidance.

Secrets and `.env` files are never committed.

## 6. Risk classification

### Low

- Documentation
- Wording
- Test additions
- Small display fixes
- Simple bug fixes

### Medium

- New APIs
- Changes across multiple features
- New dependencies
- Backward-compatible data model changes
- External service integration

### High

- Database migrations
- Authentication and authorization
- Billing
- Personal data
- Deletion and account withdrawal
- CI and deployment
- Infrastructure
- Privilege escalation
- Cryptography and secrets
- Large dependency upgrades

Meguribi uses paths, labels, and diff content in addition to AI classification, and never lets AI silently lower risk.

## 7. Process execution

- Execute an executable plus an argument array instead of building shell strings.
- Do not auto-approve unknown commands proposed by an agent.
- Require timeouts.
- Bound stdout and stderr size.
- Store binary output and control characters safely.
- Support an environment-variable allowlist for agent processes.

Repository-configured verification commands are treated as owner-approved, but still run within timeout and logging limits.

## 8. Secrets

- Read API keys from environment variables or official CLI credential stores.
- Never store secret values in resolved configuration.
- Redact tokens, authorization headers, cookies, and known secret patterns from logs.
- Provide a mode that does not inherit all environment variables into agents.
- Never load `.env` contents as agent context.
- Warn when an Issue or comment appears to contain a secret.

## 9. Prompt injection

Issues, comments, code, README files, and external resources may contain text intended to change agent behavior.

Mitigations:

- Clearly separate fixed Meguribi rules from user and repository context.
- Treat Issue instructions as requirement candidates, not permission changes.
- Flag instructions such as ignoring safety rules or revealing secrets.
- Never adopt new commands or privileges from agent output automatically.
- Do not treat external URLs as executable instructions.
- Enforce protected paths and blocked operations in code outside the prompt.

## 10. Diff limits

`.meguribi.yml` limits:

- Changed files
- Diff lines
- Binary file size
- New dependency count
- Runtime
- Agent fix attempts

When a limit is exceeded:

1. Do not commit or push.
2. Record a scope violation in `review.json`.
3. Suggest `agent:blocked`.
4. Show the user the worktree location and inspection commands.

## 11. Idempotency

- Update marker-based Issue comments instead of duplicating them.
- Use a stable branch name per Issue.
- Require resume or cleanup when a worktree already exists.
- Reuse an existing draft PR with the same head branch.
- Create a new Run ID for each execution and store input digests.

## 12. Locking

Prevent concurrent Runs for the same Issue.

```json
{
  "pid": 12345,
  "hostname": "developer-machine",
  "runId": "...",
  "createdAt": "..."
}
```

A stale lock may be removed after confirming the process no longer exists. Do not delete locks based only on elapsed time.

## 13. Retry policy

Automatic retry may be used for:

- Temporary GitHub or network failure
- One invalid Codex structured-output response
- Temporary read-only operation failure

Do not automatically retry:

- Authentication failure
- Protected-path changes
- Out-of-scope agent changes
- Test failures
- Git conflicts
- Updated Issue or base branch
- High-risk decisions

The implementation-fix loop defaults to zero attempts and starts with a maximum of one when enabled.

## 14. Cancellation

On Ctrl+C or a termination signal:

1. Start no new child process.
2. Send a termination signal to the active process.
3. Force termination after a grace period.
4. Mark the Run cancelled or failed.
5. Preserve worktree and logs.
6. Do not resume commit, push, or PR creation automatically.

## 15. Resume validation

Before resume, validate:

- Issue update time and digest
- Base branch SHA
- Worktree HEAD and dirty state
- Remote tracking state
- Existing PR head SHA
- Configuration digest
- Codex and Devin session availability

When inputs differ, show which artifacts require regeneration and wait for human direction.

## 16. Failure artifacts

Preserve as much as possible:

- `state.json`
- Completed steps
- Error category
- stdout and stderr
- Changed files
- `diff.patch`
- The next valid recovery command

A failed command must report the worktree location and recovery options rather than only saying that it failed.

## 17. Pull request safety

- Create draft PRs.
- CI success does not make a PR ready or safe to merge.
- Codex `approved` is not human approval.
- Never auto-merge.
- Never deploy to production.
- Preserve exclusions and risks in the PR body.

## 18. Auditability

A user must be able to determine:

- Which Issue, comments, and files were inputs
- Which agent, role, and session produced an artifact
- Which commit was the base
- Which commands ran
- What failed
- Where human approval occurred

Run artifacts and GitHub history provide this traceability without a custom audit database.

## 19. Devin ACP permissions

ACP permission requests are normalized at the adapter boundary into `PermissionRequest` values and evaluated by PolicyEngine. Worktree-outside paths, protected paths, Git writes, production operations, secret access, external network use, and unknown operations are denied. Test, lint, and build commands are allowed only when they match an explicit allowlist.

Interactive confirmation expires to deny. Non-interactive mode fails closed for every operation without an explicit allow decision. Decisions are idempotent per session and request ID, and requests received after session termination are invalid. No persistent `allow all` setting is provided.

## 20. Inherited MCP configuration

Meguribi must not claim complete isolation from Devin's saved MCP configuration. `warn` requires interactive confirmation and stops non-interactive runs without explicit permission. `deny` blocks detectable stdio or HTTP MCP connections and records a redacted SECURITY_ALERT before or immediately after detection. Endpoints, credentials, and tokens are never persisted before redaction.

## 21. Prompt and Git safety boundaries

Issue text, comments, previous attempts, and fix instructions are untrusted content and are explicitly delimited inside the implementation prompt. Repository rules, the primary skill, the approved plan, protected paths, and limits are separate trusted-contract blocks. Control characters, zero-width characters, delimiter escapes, secret patterns, and paths outside the worktree are normalized or rejected. The prompt version and hash are stored.

Meguribi compares Git snapshots before and after Devin execution for the repository root, common directory, HEAD, approved base SHA, branch, approved remote identity, remote, local config, reflog, protected paths, pre-existing dirty state, symlink escapes, changed-file count, diff lines, binary files, and outside-worktree changes. A violation or suspicious snapshot cannot proceed to verification, commit, push, or PR creation. A repository session without Git boundary configuration fails closed. Git diff is authoritative for changed files; agent reports are advisory. Mismatches between `reportedFiles` and the Git diff are stored as warnings in `git-boundary.json` and never override the Git result.

## 22. ACP shutdown and artifacts

Normal completion, cancellation, timeout, and protocol failure use `session/cancel` when applicable, stdin close, a grace period, SIGTERM-equivalent termination, and force termination as the final escalation. Turns time out after five minutes by default. Shutdown is idempotent. `termination.json` stores the stop reason, stage results, residual process count, and cleanup error after redaction. Residual processes or an unknown cleanup result are never treated as success.

The `experiments/devin-acp` compatibility smoke only allows connecting to the real Devin CLI with an explicit `MEGURIBI_RUN_REAL_DEVIN_SMOKE=1` opt-in. Without opt-in it returns `blocked` and does not perform external MCP connections, writes to real repositories, commit/push/PR/Issue operations, or copying/saving credentials.
