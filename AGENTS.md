# AGENTS.md

This file defines repository-wide rules for coding agents working on Meguribi.

## Product intent

Meguribi is a small, personal orchestration CLI. Do not turn it into a hosted platform, multi-tenant service, workflow engine product, or general-purpose agent framework unless an issue explicitly requests that change.

The intended responsibility is narrow:

1. Read GitHub Issue context.
2. Ask Codex to structure discovery, plans, or reviews.
3. Ask Devin to implement approved work.
4. Isolate changes in a Git worktree.
5. Run deterministic verification commands outside the agents.
6. Create or update a draft pull request.
7. Preserve the connection from hypothesis to measurement.

## Documentation language policy

- Japanese and English documentation must describe the same behavior.
- `docs/ja` is the primary source for product intent when wording differs.
- Any behavioral or architectural documentation change must update both language trees in the same pull request.
- Code identifiers, commands, schemas, labels, and file paths must be identical in both languages.

## Scope rules

- Implement only the linked Issue scope.
- Do not add a database, web UI, daemon, message queue, plugin marketplace, or cloud control plane for the MVP.
- Prefer simple local files over persistent infrastructure.
- Prefer explicit sequential execution over autonomous agent-to-agent conversation.
- Codex and Devin must be connected through Meguribi-owned artifacts, not direct recursive calls.

## Git and GitHub rules

- Never work directly on the default branch.
- Use one branch and one worktree per implementation Issue.
- Agents must not force-push, rewrite history, merge pull requests, or modify repository settings.
- Pull requests are draft by default.
- A pull request that implements an Issue must include a closing reference such as `Closes #123` when the PR targets the default branch.
- Generated Issue and PR comments must contain stable HTML markers so reruns update existing output instead of posting duplicates.

## Safety rules

- Never print, persist, or commit secrets.
- Do not modify `.env*`, credentials, deployment settings, billing, authentication, authorization, data deletion, or production workflows unless the Issue explicitly allows it and a human approval gate is recorded.
- Verification results must come from commands run by Meguribi, not from an agent's natural-language claim.
- Stop on protected-path changes, unexpected dirty state, ambiguous repository identity, or failed authentication.
- Bound retries, runtime, changed-file count, and diff size.

## Implementation conventions

Unless an accepted Issue changes the stack:

- Runtime: Node.js 22 or later.
- Language: TypeScript with strict mode.
- Package manager: pnpm.
- CLI parsing: a small established library such as Commander.
- Process execution: `execa` or an equivalent typed wrapper.
- Validation: Zod and JSON Schema where structured agent output is required.
- Tests: unit tests for parsers/builders/policies, integration tests for process adapters, and fixture-based workflow tests.

## Architecture rules

Keep adapters behind narrow interfaces:

- `GitHubAdapter`
- `GitAdapter`
- `CodexAdapter`
- `DevinAdapter`
- `Verifier`
- `RunStore`

Core workflow code must not depend directly on SDK or CLI-specific response shapes.

## Required checks

Before declaring work complete, run the repository-defined commands. Until implementation defines them, the expected baseline is:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If a check does not exist yet, document that fact in the pull request instead of pretending it passed.
