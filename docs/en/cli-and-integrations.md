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

The currently implemented CLI commands are `init`, `doctor`, `discover`, `hypothesis`, `promote`, `plan`, `review`, `run`, `resume`, and `cleanup`. `explore`, `require`, and `measure` remain specified interfaces and are not registered by the current CLI entry point.

### `meguribi init`

Diagnose whether a repository can be managed by Meguribi and generate a configuration skeleton.

```bash
meguribi init --implementer devin ./path/to/repository
```

Pass `--implementer devin` or `--implementer cursor` to select the implementation agent to diagnose. Existing `.meguribi.yml` files are never overwritten; a template is created only when the file is absent. `--json` emits diagnostics only on stdout and exits non-zero when the repository is not runnable.

Checks include:

- Git repository and remote identity
- `git`, `gh`, Codex, and the selected implementation-agent availability
- GitHub and the selected implementation-agent authentication
- default branch
- `git`, `gh`, and Codex versions
- ACP readiness for the selected implementation agent
- whether `.meguribi.yml` exists and the config action taken

Detailed package-manager, verification-command, `AGENTS.md`, and required-label checks remain part of the later delivery CLI work.

It does not write to GitHub. Automatic required-label creation (`--apply-labels`) is not implemented; delivery workflows stop when required labels are missing.

### `meguribi doctor`

Diagnose whether the local implementer agent CLI (Devin or Cursor) is runnable for Meguribi. The same diagnosis API (`diagnoseCursor` / `diagnoseDevin`) is used by `meguribi run` preflight.

```bash
meguribi doctor
meguribi doctor --json
meguribi doctor --non-interactive
meguribi doctor --implementer cursor
```

Checks include:

- resolve the configured implementer executable (Devin / Cursor / cursor-agent / agent)
- capture and parse `<executable> --version` (do not unconditionally accept unknown versions)
- authentication via `<executable> auth status` or `<executable> status` (do not read credential material)
- ACP capability probe via `<executable> acp --help` (do not start sessions or network work)
- `inheritedMcpPolicy` (never claim full MCP isolation)

Human-readable example:

```text
✓ Agent CLI: 3000.2.17
✓ Authentication: authenticated
✓ ACP: supported
! Saved agent settings may include MCP servers. Meguribi cannot fully isolate MCP.
  Policy: warn
Runnable: yes
```

`--json` prints only a stable `AgentDiagnosis` schema on stdout. Exit code is non-zero when `runnable` is false. With `--non-interactive` and `inheritedMcpPolicy: warn`, diagnosis fails closed.

### `meguribi discover`

Extract evidence-referenced problem candidates from Issues, supplied documents, or optional usage data. Observations and inferences remain separate; candidates are stored at `discoveries/<owner>/<repo>/discovery.json`, and Issues are never created automatically.

```bash
meguribi discover owner/repo --since 30d --limit 5
meguribi discover owner/repo --input observations.md --label product:discovery --json
```

Candidates are stored locally by default. Issues are not created automatically.

### `meguribi hypothesis`

Structure only the Issue sections `Observations`, `Problem candidates`, `Cause hypotheses`, `Solution hypotheses`, `Counter hypotheses`, `Validation methods`, `Success conditions`, and `Rejection conditions` into a draft artifact. Missing sections are recorded as `missingEvidence` instead of being invented, human approval is required, and the Issue comment is idempotently updated with a stable marker.

```bash
meguribi hypothesis owner/repo#123
```

### `meguribi promote`

Generate a solution-neutral Problem Issue draft from a `product:validated` Hypothesis Issue. By default only the local artifact and the source Issue comment are updated; `--create-issue` creates a new Issue only after interactive human confirmation. The command stops when observations or problem candidates are missing.

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

`plan` does not start an implementation agent. It atomically writes the plan to
`~/.local/share/meguribi/plans/<owner>/<repo>/issue-<number>/plan.json`
(`%LOCALAPPDATA%\\meguribi\\plans\\...` on Windows), and creates or updates the Issue comment with the
`<!-- meguribi:implementation-plan -->` marker. Use `--local --repo-path <path>` for a local fixture.
`--json` emits the plan and artifact path as JSON.

### `meguribi run`

Implement an approved Issue, run independent verification, perform a Codex review, and create a Draft PR. The CLI calls the `runDelivery` use case and delegates implementation to the `AgentAdapter` port (production: `createDevinAcpAdapter` or `createCursorAcpAdapter`).

```bash
meguribi run owner/repo#125
meguribi run owner/repo#125 --non-interactive --allow-inherited-mcp --json
```

Main options:

- `--repo-path <path>`
- `--implementer <devin|cursor>`
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

With `--json`, only the final result goes to stdout; progress logs go to stderr. Ctrl+C propagates through `AbortSignal` into the selected agent session cancel / shutdown.

Production GitHub / Git / Verifier adapters are injected via ports. The default CLI wiring (`createDeliveryDeps`) uses real `gh` / `git` / Codex SDK / Verifier and selects `createDevinAcpAdapter` or `createCursorAcpAdapter` from the explicit implementer setting, together with `FileSystemRunStore` and `createDefaultPolicyEngine`. Only an explicit `MEGURIBI_DELIVERY_FAKES=1` enables GitHub/Git/Codex/Verifier fakes for fixtures. Without that flag, adapter construction fails closed rather than silently falling back to an auto-approve fake. Fixture tests use fakes and do not call real `gh` or real agent CLIs.

### `meguribi review`

Re-run a read-only Codex review for an existing delivery Run worktree. The Run must have
`implementation_completed`, `plan.json`, `implementation-result.json`, and `verification.json`.
The command stops when the saved branch, HEAD, or remote identity differs. It changes no code and
only updates `review.json` plus the Issue comment with the `<!-- meguribi:code-review -->` marker.

```bash
meguribi review owner/repo#125
meguribi review owner/repo#125 --run-id 20260725T120000Z-ab12cd
```

Main options are `--run-id`, `--repo-path <path>`, `--local`, and `--json`.

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

Remove a completed Run's worktree only when its PR is closed or merged, the saved branch / HEAD / remote identity matches the PR head, and the worktree is clean. Unmerged, unsaved, or mismatched work is never deleted. Run artifacts are retained.

```bash
meguribi cleanup owner/repo#125
meguribi cleanup owner/repo#125 --dry-run
meguribi cleanup owner/repo#125 --delete-branch
```

`--delete-branch` additionally removes the local branch only for a merged PR. Remote branches are never removed.

## 3. Common options

```text
--config <path>
--json
--verbose
--quiet
--non-interactive
--dry-run
--run-id <id>
--delete-branch
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

implementer: devin

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

cursor:
  executable: cursor
  startupTimeoutMs: 10000
  turnTimeoutMinutes: 45
  inheritedMcpPolicy: warn
```

`transport: acp` is the MVP default. Never store secrets or tokens in this file.

`inheritedMcpPolicy` controls how Meguribi handles the possibility that the implementer agent CLI inherits the user's saved MCP configuration.

- `warn`: show a warning and request confirmation in interactive mode
- `deny`: stop when an MCP connection is detected
- `allow`: explicitly accept the user's agent configuration

The MVP default is `warn`. Non-interactive execution rejects `warn` and fails closed unless `allow` or `deny` is explicit. Documentation must not claim that MCP is fully isolated.

In the MVP, `transport` only accepts `acp`. `executable` must be a single executable name or path. Command-line arguments (e.g. `devin acp`), flags or environment assignments such as `--token=SECRET`, and URL schemes such as `http://...` or `file://...` are rejected. A path without spaces is supplied as a string; a path containing spaces must be supplied as a one-element array, e.g. `["C:\\Program Files\\Devin\\devin.exe"]` or `["/my dir/bin/devin"]`. Arrays with two or more elements are never allowed, so command-line arguments cannot be smuggled into the executable path. For the `MEGURIBI_DEVIN_EXECUTABLE` environment variable, a spaced path must be supplied as a JSON one-element array such as `'["C:\\\\Program Files\\\\Devin\\\\devin.exe"]']`. A plain string containing spaces is not accepted. Every timeout must be an integer greater than zero and below the Node.js setTimeout 32-bit limit (less than about 24.8 days); `turnTimeoutMinutes` is bounded so that its ms conversion stays below the same limit. Timeouts cannot be disabled or wait indefinitely. Unknown configuration keys and unknown policies are validation errors. Shell command templates, credential paths, tokens, and cookies are not configuration fields.

## 6. Configuration precedence

Lowest to highest:

1. Meguribi defaults
2. user configuration at `$XDG_CONFIG_HOME/meguribi/config.yml` when `XDG_CONFIG_HOME` is set, `%APPDATA%/meguribi/config.yml` (or `%LOCALAPPDATA%`) on Windows, and `~/.config/meguribi/config.yml` otherwise
3. repository `.meguribi.yml`
4. environment variables
5. CLI options

The environment only accepts `MEGURIBI_IMPLEMENTER`, `MEGURIBI_DEVIN_EXECUTABLE`, `MEGURIBI_DEVIN_TRANSPORT`, `MEGURIBI_DEVIN_INHERITED_MCP_POLICY`, `MEGURIBI_DEVIN_*` timeout variables, `MEGURIBI_CURSOR_EXECUTABLE`, `MEGURIBI_CURSOR_INHERITED_MCP_POLICY`, and `MEGURIBI_CURSOR_*` timeout variables. Arbitrary environment variables, tokens, and cookies are never imported into configuration.

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
- discovery, requirements, planning, and review are read-only. hypothesis writes its local artifact and only updates the existing Issue's draft comment through a stable marker
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

## 8. ACP implementation-agent integration

Devin and Cursor share the `AgentAdapter` contract. Their ACP SDK types, executable names, diagnostics, prompts, artifact stores, and transports remain inside their adapters; delivery workflow code only receives normalized `ImplementationResult` values.

### 8.1 ACP transport

The MVP uses `DevinAcpAdapter` or `CursorAcpAdapter` according to the explicit implementer selection. The following example shows the Devin path: Meguribi launches `devin acp` as a child process with the Issue-specific worktree as `cwd`; the user does not pre-launch Devin.

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

`@agentclientprotocol/sdk` is a dependency of `@meguribi/adapters` only. SDK request / event / error types must not leak into core, CLI, or RunStore. Each transport starts its selected ACP executable through `ManagedProcess` and handles `initialize` / `session/new` / `session/prompt` / `session/update`. stdout is reserved for ACP traffic; stderr is diagnostic-only. PolicyEngine permission mediation and the shared idempotent shutdown sequence are enforced at the adapter boundary.

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

The selected agent receives only:

- approved Issue content and relevant comments
- Codex `plan.json`
- repository `AGENTS.md`
- verification and prohibited-operation rules from `.meguribi.yml`
- allowed change scope
- artifact output locations

The selected agent does not:

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

`meguribi run` / `resume` call `@meguribi/core` `runDelivery` / `resumeDelivery`. Preflight uses the selected agent's diagnostic API (`preflightDevin` / `assertDevinRunnable` or `preflightCursor` / `assertCursorRunnable`). The production facade is `createDevinAcpAdapter` or `createCursorAcpAdapter`, each exposing `implement` / `fix` through the `AgentAdapter` port. Codex `analyzeFailure` is not implemented yet; `buildFixInstruction` builds fix instructions from verification / review evidence.

### 8.7 Fake Devin / ACP integration tests

Normal CI never uses the real Devin CLI, GitHub, Codex SDK, external MCP, or production credentials. `packages/adapters/src/devin/fixtures/fake-devin.js` provides CLI-compatible entry points and selects ACP behavior through the following environment variable:

```text
MEGURIBI_FAKE_DEVIN_SCENARIO=success
MEGURIBI_FAKE_DEVIN_SCENARIO=permission-denied
MEGURIBI_FAKE_DEVIN_SCENARIO=mcp-detected
MEGURIBI_FAKE_DEVIN_SCENARIO=timeout
```

The fake executable implements `--version`, `auth status`, `acp --help`, and `acp`. The existing `FAKE_DEVIN_MODE` and `FAKE_ACP_MODE` variables remain supported for lower-level component tests. When adding a scenario, update the fake Devin preflight/ACP mapping, fake ACP protocol/filesystem behavior, the relevant adapter integration test, and the process-boundary workflow test when the scenario crosses the workflow boundary. Each test uses an isolated temporary directory and verifies the residual process count in `termination.json` after shutdown.

## 8.8 Real Devin CLI compatibility smoke

The Issue #24 compatibility smoke is a manual check separated from the normal delivery workflow, `pnpm test`, and CI. It uses the dedicated `experiments/devin-acp` script and exercises the existing `DevinAcpAdapter` facade, a temporary Git repository, and an Issue-like worktree through the ACP lifecycle.

```powershell
$env:MEGURIBI_RUN_REAL_DEVIN_SMOKE = "1"
pnpm smoke:devin-acp -- --yes
```

A warning is printed before the run and an interactive prompt is shown on a TTY. For non-interactive execution, pass `--yes`. The smoke refuses to start the external agent or stops during the run when:

- explicit opt-in is missing;
- Devin CLI is unauthenticated, does not support ACP, or cannot be diagnosed;
- inherited MCP handling is not explicit for non-interactive execution;
- an outside-worktree write, protected-path change, or Git boundary violation is detected; or
- stdin close, SIGTERM, force termination when required, or residual-process checks do not complete.

Only a temporary fixture is used. The smoke does not commit, push, create PRs, update Issues, modify a real repository, or connect to external MCP servers. Devin configuration and authentication cannot be guaranteed to be isolated simultaneously, so credentials are never copied or stored and the smoke does not claim complete MCP isolation. `compatibility-result.json` and the raw/normalized event artifacts, together with their exit code, are the evidence for the result.

## 8.9 Real Cursor CLI compatibility smoke

The Issue #32 real-device compatibility smoke is a manual check separated from the normal delivery workflow, `pnpm test`, and CI. It uses the dedicated `experiments/cursor-acp` script and exercises the existing `createCursorAcpAdapter` facade, a temporary Git repository, and an Issue-like worktree through the ACP lifecycle.

```powershell
$env:MEGURIBI_RUN_REAL_CURSOR_SMOKE = "1"
pnpm smoke:cursor-acp -- --yes
```

A warning is printed before the run and an interactive prompt is shown on a TTY. For non-interactive execution, pass `--yes`. The smoke refuses to start the external agent or stops during the run when:

- explicit opt-in is missing;
- Cursor CLI is unauthenticated, does not support ACP, or cannot be diagnosed;
- inherited MCP handling is not explicit for non-interactive execution;
- an outside-worktree write, protected-path change, or Git boundary violation is detected; or
- stdin close, SIGTERM, force termination when required, or residual-process checks do not complete.

Only a temporary fixture is used. The smoke does not commit, push, create PRs, update Issues, modify a real repository, or connect to external MCP servers. Cursor configuration and authentication cannot be guaranteed to be isolated simultaneously, so credentials are never copied or stored and the smoke does not claim complete MCP isolation. `compatibility-result.json` and the raw/normalized event artifacts, together with their exit code, are the evidence for the result.

Fake ACP server smoke:

```powershell
pnpm smoke:cursor-acp:fake
$env:MEGURIBI_FAKE_CURSOR_SCENARIO = "write-outside"
pnpm smoke:cursor-acp:fake
```

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
