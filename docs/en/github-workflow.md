# GitHub Workflow Model

## 1. Principle

GitHub is the source of truth for Meguribi.

- Issues: hypotheses, problems, requirements, implementation requests, and measurements
- Issue comments: AI analysis, plans, and review material
- Labels: type, approval, and execution state
- Branches and worktrees: isolated implementation state
- Draft pull requests: implementation output awaiting review
- GitHub Actions: authoritative remote verification

Meguribi does not mirror GitHub state into a custom database. Local Run files exist only for reproducibility, logs, and resume.

## 2. Issue types

### `type:hypothesis`

Required sections:

```markdown
## Observations

## Problem candidate

## Cause hypothesis

## Solution hypothesis

## Counter-hypotheses

## Validation method

## Success conditions

## Rejection conditions
```

### `type:problem`

Required sections:

```markdown
## Problem

## Target users

## Evidence

## User impact

## Current workaround

## Unknowns

## Related Hypothesis
```

### `type:feature`

Required sections:

```markdown
## Problem being solved

## Target users

## Requirements

## Acceptance criteria

## Out of scope

## Success metrics

## Guardrails

## Related Issues
```

### `type:bug`

Required sections:

```markdown
## Symptom

## Expected result

## Actual result

## Reproduction steps

## Impact

## Acceptance criteria
```

### `type:measurement`

Required sections:

```markdown
## Original hypothesis

## Release under evaluation

## Evaluation period

## Metrics

## Qualitative evidence

## Result

## Decision
```

## 3. Labels

### Type

- `type:hypothesis`
- `type:problem`
- `type:feature`
- `type:bug`
- `type:measurement`
- `type:tech-debt`
- `type:docs`

### Product state

- `product:discovery`
- `product:validated`
- `product:rejected`
- `product:inconclusive`
- `product:approved`

### Agent state

- `agent:ready`
- `agent:running`
- `agent:review`
- `agent:blocked`

### Risk

- `risk:low`
- `risk:medium`
- `risk:high`

`meguribi init` reports missing labels. It does not create them unless the user explicitly applies the proposal.

## 4. Approval rules

A normal `type:feature` requires:

- `product:approved`
- `agent:ready`

Low-risk bugs, documentation, wording changes, and test additions may run with only `agent:ready`.

The following always require interactive approval:

- Database schema or migration changes
- Authentication or authorization
- Billing or contracts
- Personal data
- Data deletion
- CI, deployment, or production configuration
- `.github/workflows` changes
- Large dependency upgrades

Non-interactive mode stops with a blocked result for high-risk work.

## 5. Generated comments

Stable HTML markers prevent duplicate comments:

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

Meguribi updates only its own marker-based comments and never rewrites human comments.

## 6. Branches and worktrees

Branch naming:

```text
meguribi/issue-<number>-<slug>
```

Example:

```text
meguribi/issue-373-owner-leave-guard
```

Worktree location:

```text
~/.local/share/meguribi/worktrees/<owner>/<repo>/issue-<number>/
```

Creation requires:

- Local remote identity matches the GitHub repository.
- The base branch can be fetched.
- No conflicting branch or worktree exists.
- No active lock exists for the same Issue.

Existing work is never deleted automatically. Meguribi asks the user to resume or clean up.

## 7. Commits

When automatic commit is enabled, prefer one commit per Run:

```text
feat: add quick transaction entry

Refs #125
```

Automatic commit can be disabled. If commit signing is required, Meguribi respects the user's Git configuration and stops when signing fails.

## 8. Pull requests

### Draft by default

Every Meguribi-created PR begins as a draft.

### PR body

```markdown
Closes #125

## Problem being solved

## Hypothesis

## Changes

## Out of scope

## Verification

## Codex review

## Risks and review focus

## Measurement

## Meguribi metadata
```

Use `Closes #125` only when the PR targets the default branch. For another base branch, use a normal link instead of relying on automatic closure.

### Reuse

When an open draft PR already exists for the Issue, update it rather than creating another PR.

Identification order:

1. PR number stored in `state.json`
2. Head branch
3. Meguribi metadata in the PR body

## 9. CI

Local verification and GitHub Actions serve different roles:

- Local verification provides early feedback before push.
- GitHub Actions is authoritative remote verification.

This repository's `CI` workflow verifies `experiments/devin-acp` on every pull request and push with Node.js 24 and pnpm 11.1.2. Dependencies are installed with `pnpm install --frozen-lockfile`, and all of the following checks must pass in order:

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build`
5. `pnpm smoke -- --fake`

The CI workflow does not use real Devin authentication or connect to external MCP servers. It runs with read-only repository contents permission, and a newer run replaces an older in-progress run for the same pull request or branch.

Meguribi may wait for checks but never merges automatically.

```bash
meguribi run owner/repo#125 --wait-checks
```

When CI fails:

1. Store the failed check metadata and available logs.
2. Optionally ask Codex for structured failure analysis.
3. Run an automatic fix only within configured limits and with permission.
4. Keep the PR in draft and mark the Issue as review or blocked.

## 10. Human actions

The user normally:

1. Approves hypotheses, problems, and requirements.
2. Applies `product:approved` and `agent:ready`.
3. Reviews the draft PR.
4. Marks the PR ready.
5. Merges.
6. Evaluates post-release results.

Meguribi does not merge or deploy to production.

## 11. Cleanup

After a PR is merged or closed, Meguribi may remove:

- Local worktree
- Local merged branch when explicitly requested
- Remote branch only when explicitly requested
- Temporary logs after the retention period

```bash
meguribi cleanup owner/repo#125
```

Audit artifacts remain until their retention policy allows deletion.

## 12. Required GitHub permissions

The MVP needs:

- Repository metadata read
- Issues read/write
- Pull requests read/write
- Contents read/write or Git push permission
- Actions status read

Meguribi should not receive repository-settings, secrets, environment-approval, or merge permissions unless a later design explicitly requires them.
