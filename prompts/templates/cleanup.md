The task is complete and the PR has been {{FINAL_STATUS}}. Perform any cleanup needed.

## Task
{{TASK_TITLE}}: {{TASK_DESCRIPTION}}

## PR
{{PR_URL}}

## Branch
{{BRANCH_NAME}}

## Instructions
1. Delete the local and remote branch if it still exists (the PR is already {{FINAL_STATUS}})
2. Follow any agent-specific cleanup instructions below
3. Do not create any new commits or PRs
4. If there are follow-up tasks that should be tracked, describe them via the `create_tasks` array in your JSON response (same format as other prompts: include `title`, `description`, `agent`, optional `plan`, `agent_runner`, `permission_mode`). Use only when additional work truly belongs in a new task.

## Agent-Specific Cleanup Instructions
{{REPO_CONTEXT}}

## Important
Your response MUST conform to the required JSON schema. Provide:
- **status**: "completed" if cleanup succeeded, "failed" if something went wrong
- **summary**: What cleanup actions were performed
- **files_changed**: Empty array (no files should be changed)
- **assumptions**: Any decisions made
- **blockers**: Issues encountered (empty array if none)
- **next_steps**: Any remaining manual cleanup needed
- **create_tasks**: Optional array of follow-up tasks to create if cleanup revealed more work

## Available Agents
{{AGENT_DIRECTORY}}
