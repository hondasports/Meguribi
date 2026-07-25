# CLI and Integration Specification

## 1. Command form

```text
meguribi <command> <target> [options]
```

Accepted target forms:

```text
owner/repo
owner/repo#123
https://github.com/owner/repo
https://github.com/owner/repo/issues/123
https://github.com/owner/repo/pull/456
```

A target may be omitted only when the current directory is a Git repository and its remote resolves unambiguously.

## 2. Commands

### `meguribi init`

Diagnose a repository and create a configuration draft.

```bash
meguribi init ./path/to/repository
```

Checks Git identity, remote repository, `git`, `gh`, Codex, Devin, authentication, default branch, package manager, verification commands, `AGENTS.md`, and required labels. It does not modify GitHub unless `--apply-labels` is explicitly supplied.

### `meguribi discover`

Extract problem candidates from existing Issues, selected documents, and optional product data.

```bash
meguribi discover owner/repo --since 30d --limit 5
```

Options include `--since`, `--label`, `--input`, `--limit`, and `--post-comment`. The default behavior stores local candidates and does not create Issues.

### `meguribi hypothesis`

Structure observations, problem candidates, cause hypotheses, solution hypotheses, counter-hypotheses, validation methods, decision conditions, and missing evidence.

```bash
meguribi hypothesis owner/repo#123
```

### `meguribi promote`

Create a Problem Issue draft from a validated Hypothesis Issue.

```bash
meguribi promote owner/repo#123
```

The default is preview-only. `--create-issue` performs the write after human confirmation.

### `meguribi explore`

Compare multiple solution directions for a Problem Issue by user value, validation power, implementation effort, operating cost, risk, reversibility, and strategic fit.

```bash
meguribi explore owner/repo#124
```

### `meguribi require`

Convert an approved solution direction into a Requirement / Feature Issue draft.

```bash
meguribi require owner/repo#124 --solution 2
```

### `meguribi plan`

Ask Codex to inspect the repository and create a technical plan without changing files.

```bash
meguribi plan owner/repo#125
```

### `meguribi run`

Implement an approved Issue, run verification, ask Codex to review, and create a draft PR.

```bash
meguribi run owner/repo#125
```

Important options:

- `--repo-path <path>`
- `--base <branch>`
- `--no-commit`
- `--no-push`
- `--no-pr`
- `--wait-checks`
- `--allow-risk <level>`
- `--max-fix-attempts <number>`
- `--dry-run`

### `meguribi review`

Review an existing PR or an Issue-linked branch with Codex.

```bash
meguribi review owner/repo#125
meguribi review https://github.com/owner/repo/pull/456
```

### `meguribi resume`

Resume an interrupted Run after validating the Issue digest, branch, worktree, HEAD, PR, and configuration.

```bash
meguribi resume owner/repo#125
```

Meguribi stops instead of resuming when saved and current state differ unexpectedly.

### `meguribi measure`

Create a Measurement Issue draft from a Feature Issue and PR.

```bash
meguribi measure owner/repo#125 --period 14d
```

### `meguribi cleanup`

Clean up worktrees and temporary state for a completed Run.

```bash
meguribi cleanup owner/repo#125
```

## 3. Common options

```text
--config <path>
--json
--verbose
--quiet
--non-interactive
--dry-run
--run-id <id>
```

In `--json` mode, stdout contains only the final JSON result and progress logs go to stderr.

## 4. Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success |
| 1 | General failure |
| 2 | Argument or configuration error |
| 3 | Authentication or permission error |
| 4 | Missing approval or policy block |
| 5 | Git or worktree conflict |
| 6 | Agent execution failure |
| 7 | Verification failure |
| 8 | GitHub update failure |
| 9 | Cancelled or interrupted |

## 5. Repository configuration

`.meguribi.yml` lives at the target repository root.

```yaml
version: 1

repository:
  baseBranch: main

commands:
  install:
    - pnpm install --frozen-lockfile
  verify:
    - name: lint
      run: pnpm lint
    - name: typecheck
      run: pnpm typecheck
    - name: test
      run: pnpm test
    - name: build
      run: pnpm build

paths:
  protected:
    - .env
    - .env.*
    - .github/workflows/**
    - '**/*secret*'

limits:
  timeoutMinutes: 60
  maxChangedFiles: 20
  maxDiffLines: 1500
  maxFixAttempts: 1

approvals:
  productLabel: product:approved
  readyLabel: agent:ready
  highRiskInteractiveOnly: true

github:
  createDraftPullRequest: true
  waitForChecks: false

codex:
  sandboxMode: read-only
  networkAccess: false

devin:
  executable: devin
  commandTemplate:
    - '{executable}'
    - '{promptFile}'
```

The actual Devin command template is configured for the installed version. Tokens and secrets never belong in this file.

## 6. Configuration precedence

From lowest to highest:

1. Built-in defaults
2. User config at `~/.config/meguribi/config.yml`
3. Repository `.meguribi.yml`
4. Environment variables
5. CLI options

The resolved non-secret configuration is stored with each Run.

## 7. Codex integration

The first implementation uses `@openai/codex-sdk`.

```ts
export interface CodexAdapter {
  createHypothesis(input: HypothesisInput): Promise<HypothesisArtifact>;
  createRequirements(input: RequirementInput): Promise<RequirementArtifact>;
  createPlan(input: PlanningInput): Promise<PlanArtifact>;
  review(input: ReviewInput): Promise<ReviewArtifact>;
  analyzeFailure(input: FailureInput): Promise<FixInstructionArtifact>;
}
```

Thread rules:

- Separate threads by role.
- Resume only for follow-up work on the same task.
- Store thread IDs with the Run.
- Do not pass the entire business conversation to implementation roles.

```text
hypothesis thread
requirements thread
planning thread
review thread
```

Discovery, requirements, planning, and review are read-only by default. Network access is disabled unless an explicit Issue and policy allow it.

Every control-flow-relevant Codex result must conform to a command-specific JSON Schema. Meguribi does not parse arbitrary prose to determine workflow state.

## 8. Devin integration

The first implementation launches Devin as a child process.

```ts
export interface DevinAdapter {
  implement(input: ImplementationInput): Promise<ImplementationResult>;
  fix(input: FixInput): Promise<ImplementationResult>;
}
```

Because CLI flags may differ between versions, the following belong to configuration or a version-specific driver:

- Executable
- Argument template
- Prompt delivery mechanism
- Result and session-ID extraction
- Resume mechanism
- Sandbox settings

Meguribi detects the installed version and stops for unsupported versions.

Devin receives only:

- Approved Issue content and relevant comments
- Codex `plan.json`
- Repository `AGENTS.md`
- Verification and prohibited-operation rules from `.meguribi.yml`
- Allowed change scope
- Artifact output locations

It does not receive Codex private reasoning or unfiltered conversation history.

Devin does not directly update GitHub, create branches, commit, push, merge, deploy, obtain secrets, or modify paths outside the worktree.

### 8.1 Issue #3 ACP PoC result (2026-07-25)

With Devin CLI `3000.2.17`, `devin acp` is available and a TypeScript client can establish an ACP stdio connection. The PoC confirmed `initialize`, `session/new`, `session/prompt`, `session/cancel`, and `session/update`, and changed `README.md` inside a fixture worktree using ACP SDK `1.3.0`. No changes were detected in the normal checkout or outside the worktree.

The real smoke test showed that the child process remained alive after the prompt completed, but this is a process-shutdown concern rather than an ACP communication failure. The client can save `stopReason`, close stdin, wait for a short grace period, send `SIGTERM`, and force-kill only if necessary. This safely closed the session in the PoC, and no residual process was observed.

- Even with an empty `--config`, the CLI automatically connected to stored MCP configuration and attempted external HTTP / stdio MCP startup. The PoC cannot guarantee the required no-network, no-secret, and no-external-service constraints merely by launching ACP.

The current decision is: ACP is usable and a candidate for MVP adoption when shutdown includes controlled `SIGTERM`. Do not integrate it into the production adapter until MCP auto-connection can be disabled or controlled with an allowlist for the supported CLI version and configuration. Keep `DevinPrintAdapter` as the fallback if MCP control cannot be established.

## 9. GitHub integration

The MVP uses the `gh` CLI and verifies availability and authentication before work begins.

Typical operations:

- `gh issue view --json ...`
- `gh issue list --json ...`
- `gh issue comment`
- `gh issue edit`
- `gh pr list --json ...`
- `gh pr create --draft`
- `gh pr checks`

Commands are executed with an executable plus argument array, never by concatenating untrusted text into a shell command.

## 10. Git integration

Typical operations:

```text
git remote get-url origin
git fetch origin <base>
git worktree add
git status --porcelain=v2
git diff --binary
git diff --numstat
git add -- <explicit paths>
git commit
git push -u origin <branch>
git worktree remove
```

Meguribi stages only verified changed files. It does not use unconditional `git add -A`.

## 11. Non-interactive mode

`--non-interactive` stops when:

- Approval labels are missing.
- High-risk work is detected.
- Branch, worktree, or PR state conflicts.
- The Devin CLI version is unsupported.
- A protected path changes.
- The automatic fix limit is reached.
- An unexpected dirty state exists.

Meguribi does not guess its way through a condition that cannot be resolved safely.
