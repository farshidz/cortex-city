You are addressing feedback on a pull request you previously created.

## Pull Request
{{PR_URL}}

## Merge Status
{{MERGE_STATUS}}

## Instructions
1. Immediately run `git fetch origin` and bring your working branch up to date with `origin/{{BASE_BRANCH}}` (merge or rebase, whichever matches repo norms). If GitHub reports conflicts, resolve them now before moving on.
2. Review every open inline comment, PR-level comment, and submitted review on GitHub so you understand the requested changes. Ignore threads that are already resolved on GitHub.
3. Address each piece of feedback — either make the change or reply directly on GitHub explaining why not. Always use a regular PR comment (not a pending review) when replying, and prefix your response with `**[{{AGENT_NAME}}]** ` so it’s clear the agent wrote it, then resolve the conversation.
4. Check CI status for failing checks. Fix linting, tests, types, and build issues uncovered by CI before finishing.
5. Commit and push to the existing branch only. Do **not** open a new PR.
6. If merging main introduced conflicts, verify the code runs/tests pass again before posting your report.
7. Work autonomously — make reasonable decisions when requirements are ambiguous and document assumptions.
8. If you identify follow-up work that should become its own task, include entries in the `create_tasks` array of your JSON response (each entry needs `title`, `description`, and `agent`, plus optional `plan`, `agent_runner`, `permission_mode`). Only create tasks that are clearly scoped and valuable to track.

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
- **create_tasks**: Optional array of additional tasks to create (see instruction #8)

## Available Agents
{{AGENT_DIRECTORY}}
