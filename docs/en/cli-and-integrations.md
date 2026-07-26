# CLI and integration specification

## 1. CLI form

```text
meguribi <command> <target> [options]
```

Accepted targets:

```text
owner/repo
owner/repo#123
https://github.com/owner/repo
https://github.com/owner/repo/issues/123
https://github.com/owner/repo/pull/456
```

The repository may be omitted only when the current directory is a Git repository and its remote resolves to exactly one GitHub repository.

## 2. Commands

### `meguribi init`

Diagnose whether a repository can be managed by Meguribi and generate a configuration skeleton.

```bash
meguribi init ./path/to/repository
```

Checks include:

- Git repository and remote identity
- `git`, `gh`, Codex, and Devin availability
- GitHub, Codex, and Devin authentication
- default branch
- package manager and verification commands
- `AGENTS.md`
- required labels

It does not write to GitHub unless `--apply-labels` is explicitly supplied.

### `meguribi doctor`

Diagnose whether the local Devin CLI is runnable for Meguribi. The same diagnosis API (`diagnoseDevin`) is used by `meguribi run` preflight.

```bash
meguribi doctor
meguribi doctor --json
meguribi doctor --non-interactive
```

Checks include:

- resolve the configured Devin executable
- capture and parse `devin --version` (do not unconditionally accept unknown versions)
- authentication via `devin auth status` (do not read credential material)
- ACP capability probe via `devin acp --help` (do not start sessions or network work)
- `inheritedMcpPolicy` (never claim full MCP isolation)

Human-readable example:

```text
✓ Devin CLI: 3000.2.17
✓ Authentication: authenticated
✓ ACP: supported
! Saved Devin settings may include MCP servers. Meguribi cannot fully isolate MCP.
  Policy: warn
Runnable: yes
```

`--json` prints only a stable `DevinDiagnosis` schema on stdout. Exit code is non-zero when `runnable` is false. With `--non-interactive` and `inheritedMcpPolicy: warn`, diagnosis fails closed.

### `meguribi discover`

Extract candidate problems from Issues, supplied documents, or optional usage data.

```bash
meguribi discover owner/repo --since 30d --limit 5
```

Candidates are stored locally by default. Issues are not created automatically.

### `meguribi hypothesis`

Structure a hypothesis from a candidate or Issue.

```bash
meguribi hypothesis owner/repo#123
```

### `meguribi promote`

Generate a Problem Issue draft from a validated Hypothesis Issue.

```bash
meguribi promote owner/repo#123
```

The default is a local draft. `--create-issue` writes only after human confirmation.

### `meguribi explore`

Compare multiple solution directions for a Problem Issue.

```bash
meguribi explore owner/repo#124
```

Comparison dimensions include user value, validation power, implementation and operating cost, risk, reversibility, and product fit.

### `meguribi require`

Convert a selected solution into a Requirement / Feature Issue draft.

```bash
meguribi require owner/repo#124 --solution 2
```

### `meguribi plan`

Ask Codex to inspect the repository and produce a technical plan. `plan` is read-only.

```bash
meguribi plan owner/repo#125
```

### `meguribi run`

Implement an approved Issue, run independent verification, perform a Codex review, and create a Draft PR. The CLI calls the `runDelivery` use case and delegates implementation to the `DevinAdapter` port (production: `createDevinAcpAdapter`).

```bash
meguribi run owner/repo#125
meguribi run owner/repo#125 --non-interactive --allow-inherited-mcp --json
```

Main options:

- `--repo-path <path>`
- `--base <branch>`
- `--no-commit`
- `--no-push`
- `--no-pr`
- `--non-interactive`
- `--allow-inherited-mcp`
- `--max-fix-attempts <number>`
- `--json`
- `--wait-checks`
- `--allow-risk <level>`
- `--dry-run`

With `--json`, only the final result goes to stdout; progress logs go to stderr. Ctrl+C propagates through `AbortSignal` into Devin session cancel / shutdown.

Production GitHub / Git / Verifier adapters are injected via ports. The default CLI wiring (`createDeliveryDeps`) uses `createDevinAcpAdapter`, `FileSystemRunStore`, and `createDefaultPolicyEngine`. Until dedicated GitHub/Git adapters land, those ports use fakes. Set `MEGURIBI_DELIVERY_FAKES=1` to also fake Codex/Verifier; without that flag, Codex wiring fails closed if the Codex SDK cannot be constructed (no silent auto-approve fake). Fixture tests use fakes and do not call real `gh` or real Devin.

### `meguribi review`

Review an existing PR or an Issue-associated branch with Codex.

```bash
meguribi review owner/repo#125
meguribi review https://github.com/owner/repo/pull/456
```

### `meguribi resume`

Resume an interrupted Run from the last completed step. In the MVP, only steps after `implementation_completed` (verify / review / publish) are resumable. Mid-implementation session resume is not guaranteed. Identity mismatches (branch / worktree / HEAD / remote) stop the Run.

```bash
meguribi resume owner/repo#125
meguribi resume owner/repo#125 --run-id 20260725T120000Z-ab12cd
```

### `meguribi measure`

Create a Measurement Issue draft from a Requirement / Feature Issue and PR.

```bash
meguribi measure owner/repo#125 --period 14d
```

### `meguribi cleanup`

Remove temporary state and completed worktrees without deleting unmerged or unsaved work.

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

With `--json`, stdout contains only the final JSON result and progress logs go to stderr.

## 4. Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success |
| 1 | General execution failure |
| 2 | Argument or configuration error |
| 3 | Authentication or permission error |
| 4 | Missing approval or policy block |
| 5 | Git or worktree conflict |
| 6 | Agent execution failure |
| 7 | Verification failure |
| 8 | GitHub update failure |
| 9 | Cancellation or interruption |

## 5. Configuration

Place `.meguribi.yml` in the repository root.

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
  transport: acp
  gracefulShutdownMs: 2000
  terminateTimeoutMs: 3000
  forceKillTimeoutMs: 1000
  startupTimeoutMs: 10000
  turnTimeoutMinutes: 45
  inheritedMcpPolicy: warn
```

`transport: acp` is the MVP default. Never store secrets or tokens in this file.

`inheritedMcpPolicy` controls how Meguribi handles the possibility that Devin CLI inherits the user's saved MCP configuration.

- `warn`: show a warning and request confirmation in interactive mode
- `deny`: stop when an MCP connection is detected
- `allow`: explicitly accept the user's Devin configuration

The MVP default is `warn`. Non-interactive execution rejects `warn` and fails closed unless `allow` or `deny` is explicit. Documentation must not claim that MCP is fully isolated.

In the MVP, `transport` only accepts `acp`. `executable` must be a single executable name or path. Command-line arguments (e.g. `devin acp`), flags or environment assignments such as `--token=SECRET`, and URL schemes such as `http://...` or `file://...` are rejected. A path without spaces is supplied as a string; a path containing spaces must be supplied as a one-element array, e.g. `["C:\\Program Files\\Devin\\devin.exe"]` or `["/my dir/bin/devin"]`. Arrays with two or more elements are never allowed, so command-line arguments cannot be smuggled into the executable path. For the `MEGURIBI_DEVIN_EXECUTABLE` environment variable, a spaced path must be supplied as a JSON one-element array such as `'["C:\\\\Program Files\\\\Devin\\\\devin.exe"]']`. A plain string containing spaces is not accepted. Every timeout must be an integer greater than zero and below the Node.js setTimeout 32-bit limit (less than about 24.8 days); `turnTimeoutMinutes` is bounded so that its ms conversion stays below the same limit. Timeouts cannot be disabled or wait indefinitely. Unknown configuration keys and unknown policies are validation errors. Shell command templates, credential paths, tokens, and cookies are not configuration fields.

## 6. Configuration precedence

Lowest to highest:

1. Meguribi defaults
2. user configuration at `$XDG_CONFIG_HOME/meguribi/config.yml` when `XDG_CONFIG_HOME` is set, `%APPDATA%/meguribi/config.yml` (or `%LOCALAPPDATA%`) on Windows, and `~/.config/meguribi/config.yml` otherwise
3. repository `.meguribi.yml`
4. environment variables
5. CLI options

Only `MEGURIBI_DEVIN_EXECUTABLE`, `MEGURIBI_DEVIN_TRANSPORT`, `MEGURIBI_DEVIN_INHERITED_MCP_POLICY`, and the documented `MEGURIBI_DEVIN_*` timeout variables are accepted from the environment. Arbitrary environment variables, tokens, and cookies are never imported into configuration.

Each Run stores the resolved, redacted configuration in `state.json`.

## 7. Codex integration

### 7.1 Transport

The initial implementation uses `@openai/codex-sdk`.

```ts
export interface CodexAdapter {
  createHypothesis(input: HypothesisInput): Promise<HypothesisArtifact>;
  createRequirements(input: RequirementInput): Promise<RequirementArtifact>;
  createPlan(input: PlanningInput): Promise<PlanArtifact>;
  review(input: ReviewInput): Promise<ReviewArtifact>;
  analyzeFailure(input: FailureInput): Promise<FixInstructionArtifact>;
}
```

### 7.2 Threads and permissions

- Separate threads by role
- Resume only follow-up work for the same task
- Store thread IDs with the Run
- discovery, hypothesis, requirements, planning, and review are read-only
- network access is disabled by default
- Codex does not modify code in the MVP

### 7.3 Structured output

Control-flow-relevant output must conform to a command-specific JSON Schema. Meguribi does not parse arbitrary prose to determine workflow state.

### 7.4 Planning and review adapter rules

`@meguribi/adapters` uses `@openai/codex-sdk` only inside the adapter and provides two read-only operations:

- `createPlan`: creates `plan.json` from the Issue, completion criteria, out-of-scope items, and repository rules.
- `review`: creates `review.json` from the Issue, plan, Git diff, and verification result.

Planning and review run with `sandboxMode: read-only`, `approvalPolicy: never`, and network access disabled. If workspace snapshots differ before and after execution, the adapter stops with `policy_blocked`.

Codex structured output is validated by both a runtime schema and a JSON Schema. Invalid JSON or schema output is retried at most once with a repair prompt containing only the validation summary; a second failure is never treated as success. Timeouts, cancellation, empty responses, stream interruption, and process failures are classified errors.

The thread ID, source digests, duration, and redacted event log are stored as Meguribi-owned artifact metadata. Planning verifies the Issue digest, while review verifies canonical JSON digests for the Issue, plan, diff, and verification before starting Codex. A Codex review approval never authorizes publishing, removing Draft status, or merging.

## 8. Devin integration

### 8.1 Adopted transport

The MVP adopts `DevinAcpAdapter`. Meguribi launches `devin acp` as a child process with the Issue-specific worktree as `cwd`. The user does not pre-launch Devin.

```text
Meguribi
  -> DevinAcpAdapter
      -> DevinAcpTransport / session
          -> @agentclientprotocol/sdk (adapters package only)
          -> ManagedProcess (`devin acp`)
```

```ts
export interface DevinAdapter {
  implement(input: ImplementationInput): Promise<ImplementationResult>;
  fix(input: FixInput): Promise<ImplementationResult>;
}
```

`@agentclientprotocol/sdk` is a dependency of `@meguribi/adapters` only. SDK request / event / error types must not leak into core, CLI, or RunStore. Transport starts `devin acp` through `ManagedProcess` and handles `initialize` / `session/new` / `session/prompt` / `session/update`. stdout is reserved for ACP traffic; stderr is diagnostic-only. PolicyEngine permission mediation and the full shutdown sequence are completed in later issues.

ACP-specific requests, events, and errors remain inside the adapter. Core workflows consume normalized `AgentEvent` and domain types.

### 8.2 ACP session lifecycle

The adapter handles at least:

```text
process spawn
  -> initialize
  -> session/new
  -> session/prompt
  -> session/update stream
  -> turn completion
  -> controlled shutdown
```

Persist:

- Devin CLI version
- session ID
- raw ACP event log
- normalized event log
- stderr diagnostics
- stop reason
- duration
- process exit code or signal
- changed files verified by Git

Agent-reported changed files are advisory. The Git adapter is authoritative.

### 8.3 Shutdown sequence

Issue #3 showed that `devin acp` can remain alive after a prompt completes. This is treated as ACP server process lifetime, not a protocol failure.

Normal completion:

1. persist turn completion and `stopReason`
2. close stdin
3. wait a short grace period
4. send `SIGTERM` if still running
5. force-kill only if it still does not exit
6. verify that the process tree has no residual children

Cancellation or timeout:

1. send `session/cancel` when possible
2. close stdin
3. send `SIGTERM` after the grace period
4. force termination only when required

POSIX uses `SIGTERM` / `SIGKILL`. Windows-equivalent process-tree termination is hidden behind `ProcessTerminator`.

### 8.4 Inherited MCP configuration

Issue #3 and #6 showed that `devin acp` may read saved MCP configuration in the normal user environment. Fully redirecting `HOME` and XDG-related directories blocked saved MCP connections but also removed Devin authentication.

This proves that **Devin CLI configuration isolation and authentication preservation could not be guaranteed together**. It does not prove that ACP is uniquely unsafe or that switching to `--print` solves the problem.

The decision is therefore:

- adopt ACP because it provides structured events, permission requests, cancellation, and session management
- treat MCP inheritance as a Devin CLI execution-environment constraint
- warn during preflight and request confirmation in interactive mode
- stop before prompting when an unexpected MCP connection can be detected
- never copy credentials or store them in a Meguribi-specific format
- never claim complete MCP isolation

`DevinPrintAdapter` remains only a fallback if ACP compatibility is lost.

### 8.5 Inputs and prohibited operations

Devin receives only:

- approved Issue content and relevant comments
- Codex `plan.json`
- repository `AGENTS.md`
- verification and prohibited-operation rules from `.meguribi.yml`
- allowed change scope
- artifact output locations

Devin does not:

- directly update Issues or PRs
- create branches
- commit, push, or merge
- deploy to production
- retrieve secrets
- modify outside the assigned worktree
- invoke `/handoff` or create cloud sessions

### 8.6 Version diagnosis / preflight

Before launch, run the same diagnosis as `meguribi doctor`:

- `devin --version`
- authentication (`devin auth status`)
- ACP capability probe (`devin acp --help`)
- `inheritedMcpPolicy`

Do not infer safety from the version string alone. Unparseable versions are `unknown` and still require a successful ACP probe. Parseable versions below `MINIMUM_SUPPORTED_DEVIN_CLI_VERSION` (default `3000.0.0`) are `unsupported_version`. Non-zero exit or timeout from `--version` fails closed. Missing ACP is reported as `capability_missing`, distinct from `unsupported_version`. Unsupported versions, missing authentication, missing ACP, ambiguous MCP policy in non-interactive mode, and unexpected process exits stop the Run. Diagnosis output must not retain secret-like strings.

`meguribi run` / `resume` call `@meguribi/core` `runDelivery` / `resumeDelivery`. Devin preflight must use `preflightDevin` / `assertDevinRunnable` from `@meguribi/adapters`. The production facade is `createDevinAcpAdapter`, which exposes `implement` / `fix` as the `DevinAdapter` port. Codex `analyzeFailure` is not implemented yet; `buildFixInstruction` builds fix instructions from verification / review evidence.

## 9. GitHub integration

The MVP uses `gh` CLI and checks version, authentication, and repository identity before work begins.

Typical operations:

- read Issues, comments, and labels
- create or update Meguribi-managed comments
- create Draft PRs
- read PR and CI status

Commands use an executable plus argument array. Untrusted content is never concatenated into a shell command.

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

Meguribi stages only verified paths and does not use unconditional `git add -A`.

## 11. Non-interactive mode

`--non-interactive` stops when:

- approval labels are missing
- high-risk work is detected
- branch, worktree, or PR state conflicts
- Devin CLI is unknown or unsupported
- Devin is unauthenticated
- ACP initialization fails
- inherited MCP use has not been explicitly accepted
- a protected path changes
- the automatic fix limit is reached
- an unexpected dirty state exists

Meguribi does not guess its way through a condition that cannot be resolved safely.
