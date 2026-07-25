# ADR 0001: Adopt ACP as the Devin implementation transport

- Status: Accepted
- Date: 2026-07-25
- Related: Issue #3, Issue #6, PR #5, PR #7

## Context

Meguribi uses the local Devin CLI to implement approved Issues.

Two transports were considered:

1. `DevinAcpAdapter`, which launches `devin acp` as a stdio ACP server
2. `DevinPrintAdapter`, which uses a non-interactive CLI mode such as `devin --print`

Issue #3 confirmed that a TypeScript client can launch `devin acp`, complete `initialize`, `session/new`, `session/prompt`, receive `session/update`, and send `session/cancel`. The real smoke test modified only the assigned fixture worktree and did not change the normal checkout or paths outside the worktree.

The normal user environment also showed that Devin CLI may load saved MCP configuration. Issue #6 found that redirecting `HOME` and XDG-related directories blocked saved MCP connections, but also removed Devin authentication.

Issue #6 initially concluded that `DevinAcpAdapter` should not be adopted. That conclusion went beyond the evidence: the experiment did not compare ACP and `--print` under identical conditions, did not prove that MCP inheritance is ACP-specific, and did not prove that switching to `--print` solves the configuration and authentication problem.

## Decision

Adopt `DevinAcpAdapter` as the MVP Devin transport.

Reasons:

- structured sessions and events
- permission request handling
- `session/cancel`
- straightforward normalization of turn completion, tool execution, and failures
- better integration with `RunStore` and progress reporting
- no evidence that `--print` resolves the configuration or authentication constraint

`DevinPrintAdapter` remains only a fallback if ACP compatibility is lost.

## Controlled shutdown

`devin acp` can remain alive as a server after a prompt completes, so Meguribi explicitly owns process lifecycle.

Normal completion:

1. persist turn completion and `stopReason`
2. close stdin
3. wait for a grace period
4. send `SIGTERM` if the process is still running
5. force termination only if required
6. verify that the process tree has no residual children

On cancellation or timeout, send `session/cancel` when possible and then use the same shutdown sequence.

On Windows, platform-equivalent process-tree termination is hidden behind an adapter rather than assuming POSIX signal semantics.

## MCP inheritance policy

Treat MCP inheritance as a Devin CLI execution-environment constraint, not an ACP-specific defect.

- warn before execution that saved MCP configuration may be inherited
- request user confirmation in interactive mode
- fail closed in non-interactive mode unless inheritance was explicitly accepted
- stop before prompting when an unexpected MCP connection can be detected
- never copy, transform, or persist credentials in a Meguribi-specific format
- never claim that MCP is fully isolated

## Consequences

### Positive

- structured progress, permission, cancellation, and session data
- a common internal `AgentEvent` model despite different Codex and Devin transports
- simpler timeout, resume, and audit-log integration

### Negative

- explicit process cleanup is required after prompt completion
- saved MCP configuration may still be inherited
- non-interactive runs fail closed more often
- ACP payload and CLI version differences must remain behind adapter and driver boundaries

## Revisit conditions

Re-evaluate the transport when:

- Devin CLI provides supported MCP deny-all / allowlist and authentication separation
- ACP compatibility is lost
- safe ACP process cleanup is no longer possible
- another transport demonstrates a clear safety or capability advantage
