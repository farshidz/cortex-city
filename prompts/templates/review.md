You are addressing feedback on a pull request you previously created.

## Pull Request
{{PR_URL}}

## Merge Status
{{MERGE_STATUS}}

## Instructions
1. Immediately run `git fetch origin` and merge `origin/{{BASE_BRANCH}}` into your working branch. Do not rebase. If GitHub reports conflicts, resolve them now before moving on.
2. Follow this GitHub review protocol exactly. You must inspect all three feedback surfaces separately before deciding there is nothing to do:
   - submitted review bodies
   - PR conversation comments
   - inline review comments and threads
3. Do not rely only on unresolved review threads. A submitted review body with no thread is still actionable feedback. `0` unresolved threads does not mean there is no review feedback.
4. Ignore draft or pending review artifacts. Only treat submitted review bodies, submitted inline review comments/threads, and posted PR conversation comments as actionable feedback. Pending inline review threads may appear in tooling before the reviewer submits their review; do not reply to them, resolve them, or change code for them until the review is submitted.
5. Before concluding there is no new feedback, explicitly verify that there are no new submitted review bodies or PR conversation comments since the last agent response in addition to checking inline threads.
6. Address each actionable piece of feedback — either make the change or reply directly on GitHub explaining why not. If the feedback is on an inline review thread, reply in that same thread. If the feedback is a PR-level comment or review body, use a regular PR comment (not a pending review) when replying. Prefix your response with `**🤖[{{AGENT_NAME}}]** ` so it’s clear the agent wrote it, then resolve the conversation where appropriate.
7. In your own reasoning, keep these categories distinct: unresolved inline threads, submitted review-body feedback, and PR conversation comments. Do not collapse them into a single proxy such as thread count.
8. Check CI status for failing checks first. Prefer GitHub Actions or other remote CI results over running heavy local validation on this host.
9. If local validation is needed, run only the narrowest checks relevant to the files you changed. Prefer tests you added or modified, or the smallest targeted test command that covers your changes. Do not run the full local test suite on this host.
10. Commit and push to the existing branch only. Do **not** open a new PR. Let GitHub Actions or remote CI run the full test suite after you push.
11. Do not wait for post-push CI to finish. Report what you changed and let the orchestrator pick up any later CI failures on a future review run.
12. Work autonomously — make reasonable decisions when requirements are ambiguous and document assumptions.

## Response Format
Your response MUST conform to the required JSON schema. Provide:
- **status**: "completed" if all comments and CI issues are addressed, "needs_review" if some items need human judgment, "blocked" if you hit a blocker, "failed" if something went wrong
- **summary**: What you changed to address the feedback
- **pr_url**: The existing PR URL
- **branch_name**: The branch name
- **files_changed**: Files modified in this round of changes
- **assumptions**: Decisions made without explicit guidance
- **blockers**: Issues preventing full resolution (empty array if none)
- **next_steps**: Any remaining items for the task owner
- **tool_calls**: Optional object for orchestrator follow-up task requests. If you need a follow-up task, include it in your final JSON response under `tool_calls.create_task`. Do not attempt to invoke `create_task` as an interactive session tool.

## Follow-up Task Requests
- `create_task` (include this request in your final JSON as `tool_calls.create_task`)
  - `title` *(required, string)*: Short identifier for the new task
  - `description` *(required, string)*: Detailed instructions for the follow-up work
  - `agent` *(required, string)*: Agent ID from the Available Agents list below
  - `plan` *(optional, string)*: Execution plan or checklist for the assignee

## Available Agents
{{AGENT_DIRECTORY}}

{{REPO_CONTEXT_SECTION}}
