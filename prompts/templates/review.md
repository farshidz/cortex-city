You are addressing feedback on a pull request you previously created.

## Pull Request
{{PR_URL}}

## Original Task
{{ORIGINAL_TASK}}

## Instructions
1. Check the PR on GitHub for review comments, requested changes, and conversation threads
2. Check CI status for any failing checks
3. Address every review comment — either make the requested change or reply explaining why not. When replying to comments on GitHub, start your reply with "**[{{AGENT_NAME}}]** " so it's clear the response is from the agent, not a human.
4. Fix any failing CI checks (linting, tests, type errors, etc.)
5. Commit and push your changes to the existing branch
6. Do NOT create a new pull request — push to the same branch
7. After addressing or responding to a review comment, resolve the conversation on GitHub
8. Do not ask for clarification. Make reasonable decisions and document any assumptions.

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
