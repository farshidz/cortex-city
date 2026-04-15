You are addressing feedback on a pull request you previously created.

## Pull Request
{{PR_URL}}

## Merge Status
{{MERGE_STATUS}}

## Instructions
1. Immediately run `git fetch origin` and bring your working branch up to date with `origin/{{BASE_BRANCH}}` (merge or rebase, whichever matches repo norms). If GitHub reports conflicts, resolve them now before moving on.
2. Follow this GitHub review protocol exactly. You must inspect all three feedback surfaces separately before deciding there is nothing to do:
   - submitted review bodies
   - PR conversation comments
   - inline review comments and threads
3. Do not rely only on unresolved review threads. A submitted review body with no thread is still actionable feedback. `0` unresolved threads does not mean there is no review feedback.
4. Before concluding there is no new feedback, explicitly verify that there are no new submitted review bodies or PR conversation comments since the last agent response in addition to checking inline threads.
5. Address each actionable piece of feedback — either make the change or reply directly on GitHub explaining why not. If the feedback is on an inline review thread, reply in that same thread. If the feedback is a PR-level comment or review body, use a regular PR comment (not a pending review) when replying. Prefix your response with `**[{{AGENT_NAME}}]** ` so it’s clear the agent wrote it, then resolve the conversation where appropriate.
6. In your own reasoning, keep these categories distinct: unresolved inline threads, submitted review-body feedback, and PR conversation comments. Do not collapse them into a single proxy such as thread count.
7. Check CI status for failing checks. Fix linting, tests, types, and build issues uncovered by CI before finishing.
8. Commit and push to the existing branch only. Do **not** open a new PR.
9. Do not wait for post-push CI to finish. Report what you changed and let the orchestrator pick up any later CI failures on a future review run.
10. Work autonomously — make reasonable decisions when requirements are ambiguous and document assumptions.

## Important
Your response MUST conform to the required JSON schema. Provide:
- **status**: "completed" if all comments and CI issues are addressed, "needs_review" if some items need human judgment, "blocked" if you hit a blocker, "failed" if something went wrong
- **summary**: What you changed to address the feedback
- **pr_url**: The existing PR URL
- **branch_name**: The branch name
- **files_changed**: Files modified in this round of changes
- **assumptions**: Decisions made without explicit guidance
- **blockers**: Issues preventing full resolution (empty array if none)
- **next_steps**: Any remaining items for the task owner
