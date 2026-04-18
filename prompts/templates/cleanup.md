The task is complete and the PR has been {{FINAL_STATUS}}. Perform any cleanup needed.

## Instructions
1. Delete the local and remote branch if it still exists (the PR is already {{FINAL_STATUS}})
2. Do not rebase the branch during cleanup. If you need any base-branch changes before deleting it, merge them instead.
3. Do not create any new commits or PRs
4. Verify your workspace is clean and nothing is left running

## Response Format
Your response MUST conform to the required JSON schema. Provide:
- **status**: "completed" if cleanup succeeded, "failed" if something went wrong
- **summary**: What cleanup actions were performed
- **pr_url**: The existing PR URL if relevant, otherwise an empty string
- **branch_name**: The branch that was cleaned up, or an empty string if unavailable
- **files_changed**: Empty array (no files should be changed)
- **assumptions**: Any decisions made
- **blockers**: Issues encountered (empty array if none)
- **next_steps**: Any remaining manual cleanup needed
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
