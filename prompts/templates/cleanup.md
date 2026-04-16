The task is complete and the PR has been {{FINAL_STATUS}}. Perform any cleanup needed.

## Instructions
1. Delete the local and remote branch if it still exists (the PR is already {{FINAL_STATUS}})
2. Do not create any new commits or PRs
3. Verify your workspace is clean and nothing is left running

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
- **tool_calls**: Object describing any tool usage (see Available Tools). Only include when actually invoking a tool such as `create_task`.

## Available Tools
- `create_task` (follow-up task request)
  - `title` *(required, string)*: Short identifier for the new task
  - `description` *(required, string)*: Detailed instructions for the follow-up work
  - `agent` *(required, string)*: Agent ID from the Available Agents list below
  - `plan` *(optional, string)*: Execution plan or checklist for the assignee

## Available Agents
{{AGENT_DIRECTORY}}

{{REPO_CONTEXT_SECTION}}
