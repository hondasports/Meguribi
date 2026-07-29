# Meguribi English Documentation

Meguribi is a personal CLI that connects hypotheses, problems, requirements, implementation, pull requests, and post-release learning for existing GitHub repositories.

It deliberately remains small. It coordinates GitHub Issues, Git worktrees, Codex, ACP-based implementation agents such as Devin and Cursor, and existing CI instead of becoming a hosted development platform.

## Recommended reading order

1. [Product concept and growth loop](product-and-workflow.md)
2. [System architecture](architecture.md)
3. [GitHub workflow model](github-workflow.md)
4. [CLI and integration specification](cli-and-integrations.md)
5. [Artifacts, state, and schemas](artifacts-and-schemas.md)
6. [Safety and operations](security-and-operations.md)
7. [Implementation roadmap](implementation-roadmap.md)
8. [Architecture decision records](decisions/)

## Document responsibilities

| Document | Primary audience | Defines |
|---|---|---|
| Product concept and growth loop | Product / business / developers | What Meguribi solves and where human decisions are required |
| System architecture | Implementers | Components, dependency direction, and execution sequences |
| GitHub workflow model | Users / implementers | Issue types, labels, branches, and pull requests |
| CLI and integration specification | Implementers | Commands, configuration, and agent integrations |
| Artifacts, state, and schemas | Implementers | Local storage and structured agent output |
| Safety and operations | Users / implementers | Permissions, blocked operations, retry, and recovery |
| Implementation roadmap | Implementers | MVP order, issue decomposition, and completion criteria |
| Architecture decision records | Implementers | Adopted and rejected decisions, PoC evidence, and revisit conditions |

## Current implementation scope

The implemented CLI currently consists of `init`, `doctor`, `run`, and `resume`. `init` diagnoses the repository and dependencies, then creates a `.meguribi.yml` template without overwriting an existing file. `doctor` diagnoses ACP readiness for Devin or Cursor, while `run` and `resume` orchestrate real GitHub / Git / Codex / Verifier components with the explicitly selected `AgentAdapter`. The product-growth commands and `plan` / `review` / `cleanup` remain specification/foundation work.

## Key decisions

- [ADR 0001: Adopt ACP as the Devin implementation transport](decisions/0001-adopt-devin-acp.md)

## Design priorities

1. Do not damage an existing repository.
2. Preserve traceability from Issue intent to implementation diff.
3. Separate AI proposals from human decisions.
4. Verify with real commands rather than agent claims.
5. Keep the tool small enough for one developer to understand and modify.
6. Prefer stoppability and reproducibility over autonomy.

## Source of truth

The Japanese documentation is the primary source for product intent. When behavior differs between languages, review the Japanese text and update both language trees in the same pull request.
