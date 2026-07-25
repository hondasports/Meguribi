# System Architecture

## 1. Direction

Meguribi is implemented as a single local CLI.

```text
User
  -> Meguribi CLI
      -> GitHub
      -> Git worktree
      -> Codex
      -> Devin
      -> Verification commands
```

The MVP has no database, daemon, job queue, web UI, or multiple workers.

## 2. System boundaries

### Owned by Meguribi

- Command ordering
- GitHub Issue and PR reads and writes
- Context construction for Codex and Devin
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

### Owned by Devin

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
  |     `-- devin
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
  await devin.implement({ issue, plan, workspace });
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

The Codex TypeScript SDK launches the Codex CLI and exchanges JSONL events. SDK-specific shapes remain inside the adapter.

### `DevinAdapter`

Responsibilities:

- Build a Devin execution command.
- Use the assigned worktree as the working directory.
- Pass the implementation prompt.
- Store stdout, stderr, exit code, and session metadata.
- Resume a session for an approved fix attempt when supported.

Devin command-line flags are configuration- or driver-owned because they may vary by installed version. Core workflows must not hard-code a specific flag set. A future Devin API implementation should preserve the same adapter interface.

### `Verifier`

Run repository-defined commands independently from agent claims:

- install when required
- lint
- typecheck
- test
- build

Store timestamps, exit codes, and separate logs for every command.

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
Human        CLI        GitHub       Git        Codex       Devin       CI
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
  -> Devin resumes or starts a fix run
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

- Node.js 22+
- TypeScript strict mode
- pnpm workspace
- Commander for CLI parsing
- execa for child processes
- Zod for configuration and artifact validation
- zod-to-json-schema for Codex output schemas
- YAML parser for `.meguribi.yml`
- Vitest for unit and integration tests
- ESLint or Biome for linting
- tsup or tsdown for CLI builds

Final library choices are confirmed in implementation Issues. Prefer standard APIs and small dependencies.

## 9. Run status

```text
created
  -> context_ready
  -> planned
  -> implementing
  -> verifying
  -> reviewing
  -> pr_created
  -> completed
```

Failure states:

```text
blocked
failed
cancelled
```

Update `state.json` atomically by writing a temporary file and renaming it.

## 10. Concurrency

MVP constraints:

- Only one active Run per `owner/repo#issue`.
- Codex and Devin do not write to the same worktree concurrently.
- Steps within a Run are sequential.
- Cross-Issue fetch sharing is postponed.

## 11. Extension points

Potential future adapters:

- Devin API
- Claude Code
- Slack notifications
- GitHub REST / App integration
- Analytics inputs
- Scheduled discovery

Extensions must preserve the local CLI and narrow ports rather than expanding the MVP core into a platform.
