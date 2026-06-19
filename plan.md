# Reviews Feature Plan

## Goal

Improve the review agent for reviewing other people's pull requests so it can:

- Leave GitHub comments when findings require the PR author to make a change.
- Use generated review text for uncertain, advisory, or human-decision items.
- Revisit changed PRs in follow-up runs and check whether prior agent comments were addressed.
- Report whether the agent considers the PR ready for human approval, without approving on GitHub.
- Put the summary at the top of the generated review output, before findings.

## Review Output Order

The generated review should start with a short summary. Findings should come after the summary.

Preferred order:

1. Summary
2. Agent status / approval-readiness judgment
3. Required-change findings
4. Uncertain or advisory notes for human review
5. Any relevant follow-up notes

This is only about presentation order. It should not weaken the agent's obligation to surface serious findings clearly.

## Commenting Policy

The agent should leave GitHub comments for findings that require the PR author to make a change. This should preserve the existing review standard as much as possible: the current generated summaries already identify useful findings, and the new behavior should primarily change where required-change findings are surfaced.

The agent should avoid leaving GitHub comments for uncertain or advisory points. Those should go in the generated review output so the human reviewer can decide.

If the agent is unsure whether a finding should be posted as a PR comment, it should keep it in the generated review rather than posting it to GitHub.

## Initial Review Flow

On the first review of a PR:

1. Review the current PR state.
2. Leave GitHub comments only for required author changes.
3. Put ambiguous or advisory items in the generated review.
4. Report whether the PR is ready for human approval from the agent's perspective.
5. Do not approve the PR on GitHub.

## Follow-Up Review Flow

When a PR changes after a prior agent review:

1. Reuse the same review-agent session for the PR when available.
2. Provide follow-up instructions that identify the PR and explain that the PR changed since the last run.
3. Tell the agent this is a follow-up review caused by PR changes.
4. Ask the agent to use GitHub tooling to inspect the current PR, its prior agent-authored comments, and any relevant review threads.
5. If a prior comment has been addressed, the agent should leave a follow-up comment saying so.
6. If a prior comment is still unresolved, the agent should not spam duplicates. It should keep the issue reflected in the review status.
7. The agent should still review the current PR fresh and identify new issues introduced by the latest changes.
8. The agent should leave new GitHub comments for new required author changes.
9. The agent should again report whether the PR is ready for human approval, without approving on GitHub.

## Session And State Model

Follow-up runs should reuse the same session for a given PR when possible.

The session should be tied to the PR identity, such as repo plus PR number. Reusing the same session gives the agent continuity across initial and follow-up reviews.

The system should not rely only on session memory. Each follow-up run should tell the agent to inspect the current PR state and prior GitHub comments itself. GitHub comments and review threads act as the durable source of prior review context, but the app does not need to fetch and inject them.

If the original session is unavailable, stale, or unsuitable, the system should be able to start a new session with instructions to reconstruct enough context from GitHub comments and the current PR state.

## Code Responsibilities

The app should handle orchestration, not detailed finding reconciliation.

The app should:

- Detect initial review versus follow-up review.
- Reuse the same agent session for a PR when possible.
- Track enough PR metadata to know when the PR changed and when a follow-up run is needed.
- Provide the right initial or follow-up instructions to the agent, including the PR URL and the reason for the run.
- Capture and display the agent's readiness status.

The app should not need to deterministically decide which findings to post, which prior findings are fixed, or which GitHub comments to leave. The agent owns that judgment and performs the commenting.

The app also should not fetch prior comments or review threads just to feed them into the prompt. This should mirror the existing builder-agent reviewer flow: the prompt tells the agent to use GitHub tooling to inspect the PR and act on comments, while the code handles session reuse, run scheduling, and persisted status.

## Agent Responsibilities

The agent should:

- Review the current PR state on every run.
- Leave GitHub comments for findings that require author action.
- Put uncertain or advisory items in the generated review instead of posting them as PR comments.
- On follow-up runs, inspect its prior comments and decide whether they were addressed.
- Leave follow-up comments when prior required-change comments are addressed.
- Avoid duplicate comments for issues it has already raised.
- Identify new issues introduced by follow-up changes.
- Report whether the PR is ready for human approval.
- Never approve the PR on GitHub.

## Status Display

The UI/status should make it clear whether the agent is happy with the PR.

Suggested status values:

- `ready_for_human_approval`: the agent has no blocking findings and considers the PR ready for a human reviewer.
- `needs_author_changes`: the agent still has required-change findings.
- `needs_human_decision`: the agent found uncertain or advisory items that need human judgment.
- `blocked`: the agent could not complete the review because required context or tools were unavailable.

The purpose of this status is prioritization: PRs marked ready can be reviewed by the human, while PRs still needing author changes can wait.

## Non-Goals

- Do not have the app approve PRs on GitHub.
- Do not build a full deterministic finding database unless later needed.
- Do not build an app-side comment ingestion/reconciliation layer for this change.
- Do not only re-check old comments on follow-up runs; every run must still review the current PR state.
