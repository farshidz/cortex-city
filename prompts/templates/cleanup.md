The task is complete and the PR has been {{FINAL_STATUS}}. Perform any cleanup needed.

## Instructions
1. Delete the local and remote branch if it still exists (the PR is already {{FINAL_STATUS}})
2. Do not create any new commits or PRs
3. Verify your workspace is clean and nothing is left running

## Important
Your response MUST conform to the required JSON schema. Provide:
- **status**: "completed" if cleanup succeeded, "failed" if something went wrong
- **summary**: What cleanup actions were performed
- **files_changed**: Empty array (no files should be changed)
- **assumptions**: Any decisions made
- **blockers**: Issues encountered (empty array if none)
- **next_steps**: Any remaining manual cleanup needed
