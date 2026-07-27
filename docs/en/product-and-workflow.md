# Product Concept and Growth Loop

## 1. Purpose

Meguribi is not primarily a tool for making AI write more code. Its purpose is to keep the following loop connected inside an existing GitHub repository:

```text
Observation
  -> Problem candidate
  -> Cause and solution hypotheses
  -> Validation
  -> Confirmed problem
  -> Requirements
  -> Implementation
  -> Pull request
  -> Release
  -> Measurement
  -> Next hypothesis
```

Meguribi structures the information needed by this loop, assigns narrow responsibilities to Codex and the selected implementation agent, and leaves an auditable decision trail in GitHub.

## 2. Intended user

- A developer who maintains one or more existing repositories personally.
- A developer who already uses GitHub Issues and pull requests.
- Someone who wants AI support for product thinking as well as implementation.
- Someone who wants important product and merge decisions to remain human-controlled.

## 3. Problems addressed

A coding agent by itself does not solve the following problems:

- Easy-to-implement requests may be prioritized over important problems.
- The rationale and hypothesis in an Issue may be lost by the time a PR is created.
- AI may present an unverified problem as a fact.
- Implementation completion may be mistaken for product success.
- Codex and implementation agents may have overlapping responsibilities.
- Test success may depend on an agent's natural-language claim.
- Agent changes may be mixed with the developer's normal working directory.

Meguribi uses GitHub, isolated worktrees, and structured artifacts as boundaries to reduce these risks.

## 4. Core concepts

### 4.1 Observation

A confirmed fact with a source.

Examples:

- 25% of users who opened an entry form did not complete registration.
- Three support requests describe the same operation.
- A particular test is frequently flaky.

AI-generated speculation must not be stored as an observation.

### 4.2 Problem candidate

A possible user or product difficulty inferred from observations.

Example:

- Some lightweight users cannot complete expense registration.

A problem candidate does not yet assert a cause or solution.

### 4.3 Cause hypothesis

A hypothesis about why the problem occurs.

Example:

- Category selection may be causing users to abandon registration.

### 4.4 Solution hypothesis

A hypothesis about how to improve the problem.

Example:

- Allowing amount-only provisional registration may improve completion rate.

### 4.5 Counter-hypothesis

A plausible explanation that could disprove or weaken the leading hypothesis.

Examples:

- The main cause may be the lack of a habit of opening the application.
- Reducing fields may lower the value of stored records and hurt retention.

Meguribi asks for counter-hypotheses alongside cause and solution hypotheses.

### 4.6 Requirement

An implementable behavior derived from a validated problem and an approved solution direction.

A requirement must include at least:

- Problem being solved
- Target user
- Required behavior
- Acceptance criteria
- Out of scope
- Success metrics
- Guardrail metrics
- Related Hypothesis and Problem Issues

## 5. Issue progression

```text
Hypothesis Issue
  -> Problem Issue
  -> Requirement / Feature Issue
  -> Pull Request
  -> Measurement Issue
  -> Next Hypothesis Issue
```

### 5.1 Hypothesis Issue

Purpose:

- Separate observations from assumptions.
- Define a problem candidate.
- Generate cause, solution, and counter-hypotheses.
- Define validation methods and decision conditions.

AI may draft the Issue, but a human decides whether the hypothesis is worth validating.

### 5.2 Problem Issue

Purpose:

- Confirm a problem from validation evidence.
- Describe who is affected, under what conditions, and how.
- Avoid locking in a solution too early.

### 5.3 Requirement / Feature Issue

Purpose:

- Convert an approved solution direction into implementable behavior.
- Fix acceptance criteria and explicit exclusions.
- Record approval to begin implementation.

### 5.4 Measurement Issue

Purpose:

- Carry forward the original hypothesis and success criteria.
- Record quantitative and qualitative post-release evidence.
- Decide whether to continue, iterate, expand, revert, or defer.

## 6. Responsibilities

### Codex

- Extract problem candidates from Issues and product material.
- Propose hypotheses, counter-hypotheses, and validation methods.
- Structure a problem into requirements.
- Inspect a target repository and produce a technical plan.
- Review implementation diffs and verification results.

### Devin

- Implement approved requirements and the Codex technical plan.
- Add required tests.
- Modify only the assigned worktree.
- Report unresolved items.

### Meguribi

- Fetch Issue and repository context.
- Build explicit inputs for Codex and the implementation agent.
- Store their artifacts and prevent direct agent-to-agent recursion.
- Manage worktrees, branches, verification, and draft PRs.
- Stop at human approval gates.

## 7. Human intervention

### Required

1. Promote a hypothesis to a confirmed problem.
2. Select a solution direction and MVP scope.
3. Approve high-risk implementation.
4. Merge the pull request.
5. Judge post-release success or failure.

### Optional for low-risk work

The implementation-start approval may be skipped for low-risk bug fixes, wording changes, test additions, and documentation changes.

### Always human-owned

- Which users and problems receive priority
- Pricing, contracts, personal data, authentication, and authorization policy
- Data deletion
- Major architecture changes
- Production release
- Automatic merge

## 8. Standard workflows

### Feature

```text
meguribi discover
  -> human selects a candidate
meguribi hypothesis
  -> human approves validation direction
meguribi promote
  -> human accepts the problem
meguribi require
  -> human approves requirements, exclusions, and metrics
meguribi run
  -> Codex plan -> Agent implementation -> verification -> Codex review -> Draft PR
human merges the PR
meguribi measure
  -> human evaluates the result
```

### Bug fix

```text
Bug Issue
  -> meguribi plan
  -> meguribi run
  -> Draft PR
  -> human merge
```

Bug fixes normally skip the hypothesis and problem-promotion workflow.

## 9. Success criteria for Meguribi

Meguribi is successful when:

- The relationship between Issue intent and PR diff remains visible.
- Out-of-scope changes are reduced.
- A human can review AI output quickly.
- Post-release evaluation can return to the original hypothesis.
- Failed agent runs can be stopped, resumed, or discarded safely.
- The tool remains small enough for one developer to understand and change.

## 10. Non-goals for the MVP

- Multi-user or multi-organization SaaS
- Always-on web server
- Web dashboard
- Automated roadmap decisions
- AI-driven automatic merge
- Unbounded multi-agent debate
- Large-scale parallel Issue execution
- A custom Issue tracker or code host
