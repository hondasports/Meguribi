# System Architecture

## 1. Direction

Meguribi is implemented as a single local CLI.

```text
User
  -> Meguribi CLI
      -> GitHub
      -> Git worktree
      -> Codex
      -> ACP implementation agent (Devin or Cursor)
      -> Verification commands
```

The MVP has no database, daemon, job queue, web UI, or multiple workers.

## 2. System boundaries

### Owned by Meguribi

- Command ordering
- GitHub Issue and PR reads and writes
- Context construction for Codex and implementation agents
- Structured artifact storage
- Git worktree and branch lifecycle
- Deterministic verification
- Protected-path, diff-size, timeout, and retry policies
- Draft PR creation

### Owned by Codex

- Problem candidate and hypothesis proposals
- Counter-hypotheses and validation plans
- Requirement structuring
- Repository inspection and technical planning
- Diff review and failure analysis

### Owned by the implementation agent

- Code changes within approved scope
- Test additions
- Work inside the assigned worktree
- Implementation summary and unresolved items

### Owned by GitHub

- Issues, comments, labels, milestones
- Branches and pull requests
- CI status and merge history

### Owned by the human

- Product priority
- Promotion of hypotheses, problems, and requirements
- Approval of high-risk work
- Pull request merge
- Post-release judgment

## 3. Components

```text
apps/cli
  |
  +-- core/workflows
  |     +-- discover
  |     +-- hypothesis
  |     +-- require
  |     +-- delivery
  |     `-- measure
  |
  +-- adapters
  |     +-- github
  |     +-- git
  |     +-- codex
  |     +-- acp
  |     +-- devin
  |     `-- cursor
  |
  +-- services
  |     +-- context-builder
  |     +-- prompt-builder
  |     +-- verifier
  |     +-- policy-engine
  |     `-- run-store
  |
  `-- schemas
```

### CLI

- Parse commands and options.
- Resolve the repository and Issue target.
- Start an explicit workflow.
- Present the result and the next required human action.

### Workflows

Each command is implemented as straightforward sequential TypeScript code. Meguribi does not build a generic workflow engine.

```ts
async function runDelivery(input: DeliveryInput): Promise<DeliveryResult> {
  const issue = await github.fetchIssue(input.target);
  await policy.assertReady(issue);
  const workspace = await git.createWorktree(issue);
  const plan = await codex.createPlan({ issue, workspace });
  await agent.implement({ issue, plan, workspace });
  const verification = await verifier.run(workspace);
  const review = await codex.review({ issue, plan, verification, workspace });
  return github.createDraftPullRequest({ issue, workspace, review });
}
```

### `GitHubAdapter`

Responsibilities:

- Read repository, Issue, comment, label, PR, and CI metadata.
- Find Meguribi-generated comments by marker.
- Create or update comments.
- Find or create a draft PR.

The first implementation uses the `gh` CLI. Raw CLI JSON is normalized inside the adapter and never exposed to core workflows.

### `GitAdapter`

Responsibilities:

- Verify repository identity and dirty state.
- Fetch the base branch.
- Create an Issue-specific branch and worktree.
- Read status, changed files, diff, and diff statistics.
- Stage explicit files, commit, push, and clean up.

### `CodexAdapter`

Responsibilities:

- Start or resume Codex SDK threads.
- Set working directory and permissions.
- Request JSON-Schema-constrained output.
- Store thread IDs, usage, and event logs.

Meguribi calls the `@openai/codex-sdk` API only inside the adapter and keeps SDK-specific types behind that boundary. The SDK's internal transport or process implementation is outside Meguribi's dependency boundary, so `init` does not require a `codex` executable on `PATH`.

### `AgentAdapter`

Responsibilities:

- Accept an approved `ImplementationContext` and run implement or fix inside the assigned worktree.
- Keep the ACP lifecycle (initialize / session / prompt / shutdown) inside the adapter.
- Normalize into `ImplementationResult`, with Git-authoritative `changedFiles` and artifact references.
- Never commit, push, create PRs, or update Issues.

The MVP production implementations are `createDevinAcpAdapter` (Devin) and `createCursorAcpAdapter` (Cursor). CLI / workflow depend only on the `AgentAdapter` port and never see ACP SDK types or CLI-specific output. The implementer must be selected explicitly via `MEGURIBI_IMPLEMENTER`, `implementer` in `.meguribi.yml`, or `--implementer`; otherwise Meguribi fails closed.

#### Agent execution safety boundary

`PermissionRequest`, inherited-MCP decisions, implementation prompts, Git/worktree snapshots, and shutdown are normalized and checked inside the ACP adapter (shared by Devin and Cursor). ACP SDK request/response types and CLI-specific output do not leak into core workflows. Issue text, comments, and fix instructions are delimited as untrusted content by the prompt builder; permission and Git decisions are enforced independently by PolicyEngine.

`AcpShutdownController` performs cancel, stdin close, grace period, termination, and force escalation at most once and stores the result in `termination.json`. Git snapshot changes to HEAD, branch, remote, local config, protected paths, symlinks, or diff limits feed the publish gate. Git diff remains authoritative over agent-reported changed files.

### `Verifier`

Run repository-defined commands independently from agent claims:

- install when required
- lint
- typecheck
- test
- build

Commands run as executable + argv with `shell: false`. Each command has a default 30-minute timeout and fails closed with `timedOut` when exceeded. On Windows, resolution uses PATH and `PATHEXT` order instead of blindly appending `.cmd`. Store timestamps, exit codes, and separate logs for every command.

### `PolicyEngine`

- Approval label checks
- Risk classification
- Protected-path enforcement
- Changed-file and diff-line limits
- Blocked command policy
- Retry and timeout limits
- Merge and production-deploy prohibition

### `RunStore`

Store Issue-specific execution state on the local filesystem. No database is required.

## 4. Physical layout

```text
~/repos/
  `-- target-repository/          # normal developer checkout

~/.local/share/meguribi/
  +-- runs/
  |   `-- owner/repo/issue-123/run-YYYYMMDD-HHmmss/
  +-- worktrees/
  |   `-- owner/repo/issue-123/
  `-- cache/

Meguribi repository/
  +-- apps/cli/
  +-- packages/core/
  +-- packages/adapters/
  +-- packages/schemas/
  +-- prompts/
  `-- tests/
```

Use XDG Base Directory conventions and keep temporary execution logs outside target repositories.

## 5. Delivery sequence

```text
  Human        CLI        GitHub       Git        Codex       Agent       CI
  |           |            |           |           |           |          |
  | run #123  |            |           |           |           |          |
  |---------->| fetch      |           |           |           |          |
  |           |----------->|           |           |           |          |
  |           | validate approval      |           |           |          |
  |           | create worktree ------>|           |           |          |
  |           | create plan ----------------------->|           |          |
  |           | implement ------------------------------------>|          |
  |           | verify ------------->|             |           |          |
  |           | review diff ---------------------->|           |          |
  |           | commit / push ------>|             |           |          |
  |           | create draft PR ---->|             |           |          |
  |<----------| summary              |             |           |          |
  |           |                         GitHub CI ------------------------->|
```

## 6. Fix loop

The MVP defaults to zero automatic fix attempts and allows at most one when explicitly configured.

```text
verification failure or review changes_required
  -> Codex creates structured fix instructions
  -> PolicyEngine verifies scope
  -> the selected agent resumes or starts a fix run
  -> verification runs again
  -> Meguribi stops when the attempt limit is reached
```

## 7. Dependency direction

```text
CLI -> Workflows -> Ports <- Adapters
                  -> Domain models
                  -> Schemas
```

- Workflows do not call SDKs or binaries directly.
- Adapters convert external results into domain models.
- Prompt builders have no side effects.
- Policy evaluation is deterministic and side-effect free.

## 8. Recommended stack

- Node.js 24.x (the repository pins `>=24 <25`)
- TypeScript strict mode
- pnpm workspace
- Commander for CLI parsing
- execa for child processes
- Valibot for configuration and artifact validation
- JSON Schema for Codex output schemas (generated from Valibot when needed)
- YAML parser for `.meguribi.yml`
- Vitest for unit and integration tests
- ESLint or Biome for linting
- tsup or tsdown for CLI builds

Final library choices are confirmed in implementation Issues. Prefer standard APIs and small dependencies.

## 9. Run status

Meguribi does not build a generic state machine. A Run stores a coarse `status` plus fine-grained `currentStep` / `completedSteps` in `state.json`.

Coarse status examples:

```text
created -> planning -> planned -> implementing -> verifying
  -> reviewing -> publishing -> awaiting_human
```

Fine-grained delivery steps:

```text
preflight
awaiting_mcp_confirmation
implementing
implementation_completed
implementation_blocked
verifying
reviewing
fixing
publishing
```

Failure states:

```text
blocked
failed
cancelled
timed_out
interrupted
```

`state.json` updates use temp-file + rename atomic writes. `FileSystemRunStore` owns atomic writes and per-Issue locks.

## 10. Concurrency

MVP constraints:

- Only one active Run per `owner/repo#issue`.
- Codex and the selected implementation agent do not write to the same worktree concurrently.
- Steps within a Run are sequential.
- Cross-Issue fetch sharing is postponed.

## 11. Extension points

Potential future adapters:

- Devin API
- Cursor API
- Claude Code
- Slack notifications
- GitHub REST / App integration
- Analytics inputs
- Scheduled discovery

Extensions must preserve the local CLI and narrow ports rather than expanding the MVP core into a platform.
