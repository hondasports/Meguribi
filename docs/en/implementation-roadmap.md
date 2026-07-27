# Implementation Roadmap

## 1. Delivery strategy

Meguribi should first complete one useful personal workflow rather than build a product-development platform.

The first complete loop is:

```text
GitHub Issue
  -> Codex technical plan
  -> Git worktree
  -> ACP implementation agent (Devin or Cursor)
  -> Meguribi verification
  -> Codex review
  -> Draft pull request
  -> Human merge
```

The hypothesis, problem, requirement, and measurement loop is added after delivery is stable.

## 2. Phase 0: Repository foundation

### Goal

Create the minimum TypeScript CLI repository that can be built and tested.

### Work

- Initialize pnpm workspace.
- Configure Node.js and TypeScript.
- Add CLI entry point.
- Add lint, typecheck, test, and build commands.
- Add pull-request CI.
- Add configuration schema foundation.
- Add fixture-based test support.

Recommended layout:

```text
apps/
  `-- cli/
packages/
  +-- core/
  +-- adapters/
  +-- schemas/
  `-- test-support/
prompts/
tests/fixtures/
```

### Completion criteria

- `pnpm install` succeeds.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` succeed.
- `pnpm meguribi --help` prints CLI help.
- CI runs the same checks for pull requests.

## 3. Phase 1: Delivery MVP

### Goal

Complete an existing GitHub Issue to draft-PR workflow.

### Current implementation snapshot

The repository currently has a working foundation for the delivery loop:

- `doctor` diagnoses the explicitly selected Devin or Cursor CLI, including version, authentication, ACP capability, and inherited-MCP policy.
- `run` and `resume` are registered in the CLI and call the delivery use cases.
- `AgentAdapter` is implemented by `createDevinAcpAdapter` and `createCursorAcpAdapter`.
- ACP sessions persist redacted events, prompts, Git-boundary results, normalized results, and termination results.
- The default wiring uses the real run store and policy engine, but GitHub and Git ports still use fakes until their dedicated adapters land.

The Phase 1 completion criteria are therefore not met yet. The remaining work includes the production GitHub/Git adapters and the planned `init`, `plan`, `review`, and `cleanup` command surfaces.

### 3.1 `init`

Implement:

- Local Git repository resolution
- Remote URL normalization
- GitHub repository resolution
- `git`, `gh`, Codex, and selected-agent diagnostics
- Authentication check
- Default branch detection
- `.meguribi.yml` draft generation

Completion:

- Diagnose public and private repositories.
- Report missing dependencies precisely.
- Never overwrite an existing file without confirmation.

### 3.2 GitHub adapter

Implement:

- Issue, comment, and label reads
- Marker-based comment create/update
- Draft PR lookup and creation
- CI status read

Completion:

- Fixture-test JSON normalization.
- Convert CLI failures into domain errors.
- Avoid shell command concatenation.

### 3.3 Git and worktree adapter

Implement:

- Repository identity check
- Fetch
- Branch and worktree creation
- Status, diff, and numstat
- Explicit stage
- Commit and push
- Cleanup

Completion:

- Never modify the normal checkout.
- Detect conflicts for the same Issue.
- Never commit or push directly to the default branch.
- Never delete unmerged work during cleanup.

### 3.4 RunStore

Implement:

- XDG paths
- Run IDs
- Atomic state writes
- Locking
- Logs
- Resume state reads

Completion:

- State survives interruption.
- Stale locks are handled safely.
- Secrets are not stored.

### 3.5 Codex planning adapter

Implement:

- SDK client
- Working directory
- Read-only configuration
- Plan schema
- Thread ID storage
- JSONL event log
- One schema-repair attempt

Completion:

- Produce valid `plan.json` for a fixture repository.
- Never accept invalid output as success.
- Verify that planning did not modify files.

### 3.6 ACP implementation-agent adapter

Implement:

- Executable and version detection
- Version-specific driver
- Prompt-file generation
- Worktree working directory
- Timeout and signal handling
- stdout and stderr logs
- Result normalization

Completion:

- Integration tests with fake Devin and Cursor executables/ACP servers.
- Explicit failure for unsupported versions.
- The implementation agent does not own GitHub, branch, commit, or push operations.
- Detect writes outside the worktree.

### 3.7 Verifier

Implement:

- Repository-defined verification commands
- Sequential execution
- Timeouts
- Logs
- `verification.json`

Completion:

- One failed command fails verification.
- Agent claims do not affect the result.
- Every command retains its exit code.

### 3.8 Codex review adapter

Input:

- Issue
- plan
- diff
- verification

Output:

- Review status
- Requirement coverage
- Severity-ranked findings
- Scope violations
- Human-readable PR summary

Completion:

- Structure `approved` and `changes_required` outcomes.
- Never merge based on Codex review.

### 3.9 Commands

`plan`:

- Fetch context.
- Run Codex planning.
- Update the Issue plan comment.

`run`:

- Validate approval.
- Create worktree.
- Reuse or regenerate plan.
- Run the selected implementation agent.
- Verify.
- Run Codex review.
- Commit and push.
- Create draft PR.

`review`:

- Review an existing PR or branch.

`resume`:

- Validate digests and Git state before continuation.

`cleanup`:

- Remove the worktree safely.

### Phase 1 completion

- A low-risk Issue in a real existing repository can produce a draft PR.
- Every intermediate artifact is inspectable.
- A failed run leaves the worktree and recovery guidance.
- No direct default-branch write occurs.
- No automatic merge occurs.

## 4. Phase 2: Product loop

### Goal

Add observation-to-requirement discovery and post-release learning.

### 4.1 `discover`

- Search Issues and comments by time and label.
- Accept explicit file inputs.
- Cluster repeated themes.
- Rank problem candidates.
- Separate evidence from inference.

### 4.2 `hypothesis`

- Cause, solution, and counter-hypotheses
- Validation methods
- Success and rejection conditions
- Missing evidence
- Hypothesis Issue draft

### 4.3 `promote`

- Confirm validated evidence.
- Create a Problem Issue draft.
- Link the original Hypothesis Issue.

### 4.4 `explore`

- Generate multiple solution directions.
- Compare value, effort, risk, and reversibility.
- Avoid selecting only the easiest implementation.

### 4.5 `require`

- Requirements
- Acceptance criteria
- Out of scope
- Metrics and guardrails
- Feature Issue draft

### 4.6 `measure`

- Restore the original hypothesis.
- Create a Measurement Issue draft.
- Classify the result.
- Suggest next hypothesis candidates.

### Phase 2 completion

- Hypothesis -> Problem -> Feature -> PR -> Measurement links are traceable.
- AI separates observations from assumptions.
- Meguribi does not mass-create Issues automatically.
- Every promotion requires human approval.

## 5. Phase 3: Optional extensions after real use

Candidates:

- Devin API adapter
- Claude Code adapter
- GitHub API adapter
- GitHub Actions log integration
- Slack notifications
- Scheduled discovery
- Analytics input adapters
- Prompt and schema migrations

Do not implement these until a real problem requires them, such as excessive CLI startup friction, `gh` limitations, a need for parallel Issues, unstable Devin CLI behavior, or a desire to avoid occupying a local machine.

## 6. Recommended Issue decomposition

1. `chore: scaffold TypeScript CLI workspace`
2. `feat: add configuration loader and diagnostics`
3. `feat: add local run store and locking`
4. `feat: add GitHub adapter using gh CLI`
5. `feat: add Git worktree lifecycle`
6. `feat: add Codex planning adapter`
7. `feat: add ACP implementation-agent adapters (Devin and Cursor)`
8. `feat: add deterministic verifier`
9. `feat: add Codex code review adapter`
10. `feat: implement plan command`
11. `feat: implement run command and draft PR creation`
12. `feat: implement resume and cleanup commands`
13. `feat: add discovery and hypothesis commands`
14. `feat: add problem promotion and requirement generation`
15. `feat: add measurement workflow`

Each Issue should be independently testable. Avoid combining a new adapter and the complete CLI workflow in one Issue.

## 7. Test strategy

### Unit

- Target parser
- Branch slug
- Label policy
- Risk classification
- Prompt builder
- Valibot schemas
- Configuration merge
- Redaction
- State transitions

### Integration

- Fake `gh` executable
- Temporary Git repository and worktree
- Fake Codex adapter
- Fake Devin and Cursor ACP executables/servers
- Verification command execution
- Signal and timeout handling

### Workflow fixtures

```text
fixtures/
  +-- feature-approved/
  +-- feature-missing-approval/
  +-- bug-low-risk/
  +-- protected-path-change/
  +-- verification-failure/
  +-- existing-draft-pr/
  `-- resume-input-changed/
```

### Manual smoke test

1. Create a low-risk Issue in a dedicated test repository.
2. Run `meguribi plan`.
3. Run `meguribi run`.
4. Inspect the draft PR and Issue comments.
5. Test CI failure and resume.
6. Test cleanup.

## 8. Definition of Done

Every implementation Issue must:

- Meet its acceptance criteria.
- Add unit or integration tests.
- Pass lint, typecheck, test, and build.
- Update Japanese and English behavior documentation together when required.
- Keep secrets out of logs and fixtures.
- Provide actionable recovery guidance on errors.
- Avoid destructive operations or require explicit human approval.

## 9. MVP cut line

First release:

- `init`
- `plan`
- `run`
- `review`
- `resume`
- `cleanup`
- GitHub, Git, Codex, and AgentAdapter implementations
- RunStore
- Verifier
- PolicyEngine

After the first release:

- `discover`
- `hypothesis`
- `promote`
- `explore`
- `require`
- `measure`

This validates safe Issue-to-draft-PR delivery before adding the full product growth loop.
