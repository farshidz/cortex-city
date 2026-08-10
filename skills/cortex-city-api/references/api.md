# Cortex City API operations

The bundled client maps named operations to the routes called by the Cortex City UI. A write is any POST, PUT, or DELETE request. Every write requires `--confirm`.

## Contents

- [Tasks](#tasks)
- [Issues](#issues)
- [Sessions and worker](#sessions-and-worker)
- [Reviews](#reviews)
- [Read-only configuration and status](#read-only-configuration-and-status)
- [Field values](#field-values)
- [Side effects and conflicts](#side-effects-and-conflicts)

## Common syntax

```bash
python3 skills/cortex-city-api/scripts/cortex_city_api.py OPERATION \
  [--id ID] [--query KEY=VALUE] [--data JSON | --data-file PATH] [--confirm]
```

The response is pretty-printed JSON. Add `--compact` for one-line JSON. The client exits with status 1 for HTTP failures and status 2 for invalid arguments.

## Tasks

| Operation | Request | Input |
| --- | --- | --- |
| `tasks.list` | `GET /api/tasks` | Optional query: `status` |
| `tasks.get` | `GET /api/tasks/{id}` | `--id` |
| `tasks.create` | `POST /api/tasks` | JSON body; required: `title`, `agent` |
| `tasks.update` | `PUT /api/tasks/{id}` | `--id` and a non-empty JSON body |
| `tasks.delete` | `DELETE /api/tasks/{id}` | `--id` |
| `tasks.instruct` | `POST /api/tasks/{id}/instruction` | `--id`; body: `instruction` |
| `tasks.session` | `GET /api/tasks/{id}/session` | `--id` |

`tasks.create` accepts:

- `title`, `description`, `plan`, `agent`
- `branch_name`
- `agent_runner`: `claude` or `codex`
- `permission_mode`, `model`, `effort`
- `reviewer_agent_enabled`: JSON boolean
- `issue_id`: link an unlinked issue while creating the task

`tasks.update` is limited to fields the UI edits:

- `title`, `description`, `plan`, `agent`
- `agent_runner`, `permission_mode`, `model`, `effort`
- `reviewer_agent_enabled`: JSON boolean
- `status` and `notes`; `paused`: JSON boolean

Creating a task requests a worker poll. An open task may begin running immediately. Sending an instruction queues it in `pending_manual_instruction`; Cortex City requests a poll when no run is active.

## Issues

| Operation | Request | Input |
| --- | --- | --- |
| `issues.list` | `GET /api/issues` | Queries: `show_resolved`, `page`, `page_size` |
| `issues.get` | `GET /api/issues/{id}` | `--id` |
| `issues.create` | `POST /api/issues` | Body; required: `title` |
| `issues.update` | `PUT /api/issues/{id}` | `--id` and a non-empty body |
| `issues.comment` | `POST /api/issues/{id}/comments` | `--id`; body: `body` |
| `issues.delete` | `DELETE /api/issues/{id}` | `--id` |

`issues.create` accepts `title`, `description`, `plan`, and `priority`.

`issues.update` accepts `title`, `description`, `plan`, `status`, and `priority`. Set `priority` to JSON `null` to clear it.

`issues.list` hides resolved issues unless `show_resolved=true`. `page` starts at 1. `page_size` is between 1 and 100 and defaults to 25.

An issue linked to a task cannot be deleted. Delete the linked task first; deleting a non-final task unlinks and reopens the issue, while deleting a final task preserves the issue's terminal status.

## Sessions and worker

| Operation | Request | Input |
| --- | --- | --- |
| `sessions.list` | `GET /api/sessions` | None |
| `sessions.kill` | `POST /api/sessions` | Body; required: `task_id` |
| `orchestrator.status` | `GET /api/orchestrator` | None |
| `orchestrator.poll` | `POST /api/orchestrator` | None |

For a task session, `sessions.kill` needs only `task_id`. For a review session, also send `kind: "review"` and the `run_kind` returned by `sessions.list`:

```json
{
  "task_id": "https://github.com/example/repo/pull/42",
  "kind": "review",
  "run_kind": "review"
}
```

`orchestrator.poll` requests one worker poll. It can start eligible task, review, and cleanup work.

## Reviews

| Operation | Request | Input |
| --- | --- | --- |
| `reviews.list` | `GET /api/reviews` | None |
| `reviews.regenerate` | `POST /api/reviews/summarize` | Body; required: `pr_url` |
| `reviews.followups` | `GET /api/reviews/followup` | Required query: `pr_url` |
| `reviews.followup` | `POST /api/reviews/followup` | Body; required: `pr_url`, `question` |
| `reviews.submit` | `POST /api/reviews/submit` | Body; required: `pr_url`, `decision`; optional: `body` |

`reviews.regenerate` accepts optional `runtime`, `effort`, and `model` overrides. The PR must already be present in the review cache.

`reviews.submit` writes to GitHub. `decision` is `approve`, `request-changes`, or `comment`. GitHub rejects approval or requested changes on self-authored and task-owned PRs; comments remain allowed.

Examples:

```bash
python3 skills/cortex-city-api/scripts/cortex_city_api.py reviews.followups \
  --query 'pr_url=https://github.com/example/repo/pull/42'

python3 skills/cortex-city-api/scripts/cortex_city_api.py reviews.submit \
  --data '{"pr_url":"https://github.com/example/repo/pull/42","decision":"comment","body":"Please add the missing test."}' \
  --confirm
```

## Read-only configuration and status

| Operation | Request | Notes |
| --- | --- | --- |
| `config.get` | `GET /api/config` | Global configuration and agent definitions |
| `review-learnings.get` | `GET /api/reviews/learnings` | Shared reviewer-learning content and enabled state |
| `prompts.get` | `GET /api/prompts` | Initial, review, and cleanup templates |
| `agent-prompt.get` | `GET /api/agents/{id}/prompt` | `--id`; optional `mode=initial`, `review`, or `cleanup` |
| `agent-env.get` | `GET /api/agents/{id}/env` | `--id`; values are always printed as `<redacted>` |
| `agent-status.get` | `GET /api/agent-status` | Claude and Codex quota status |
| `cortex-git.get` | `GET /api/cortex-git` | Git snapshot status shown in the UI |

Global configuration, reviewer learnings, agent prompts, and agent environment files are read-only through this skill. Do not send PUT requests to these routes.

## Field values

- Task status: `open`, `in_progress`, `in_review`, `merged`, `closed`
- Issue status: `open`, `in_progress`, `done`, `closed`
- Issue priority: `low`, `medium`, `high`; use JSON `null` to clear during update
- Runtime: `claude`, `codex`
- Permission mode: `bypassPermissions`, `acceptEdits`, `auto`, `default`, `yolo`
- Effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; runtime-specific support still applies
- Prompt mode: `initial`, `review`, `cleanup`
- Review decision: `approve`, `request-changes`, `comment`
- Review session run kind: `review`, `review_retro`

## Side effects and conflicts

- `tasks.delete` returns HTTP 409 when the task has an active session. It may remove the task worktree.
- `tasks.instruct` returns HTTP 409 for final tasks or when another manual instruction is pending.
- `issues.create` rejects an invalid priority. `tasks.create` returns HTTP 409 when its `issue_id` is already linked.
- `issues.delete` returns HTTP 409 while the issue is linked to a task.
- `sessions.kill` returns HTTP 404 when the named run is no longer active.
- `reviews.regenerate` returns HTTP 409 when another summary run is active.
- `reviews.followup` runs synchronously and returns its answer or an API error.
- `reviews.submit` creates an externally visible GitHub review or comment.
