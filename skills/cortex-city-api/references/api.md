# Cortex City API operations

The bundled client maps named operations to the routes called by the Cortex City UI. A write is any POST, PUT, or DELETE request. Every write requires `--confirm`.

## Contents

- [Tasks](#tasks)
- [Issues](#issues)
- [Reviews](#reviews)
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

Creating a task requests a worker poll. An open task may begin running immediately.

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

An issue linked to a task cannot be deleted. Resolve the link through the UI or another authorized workflow before calling `issues.delete`.

## Reviews

| Operation | Request | Input |
| --- | --- | --- |
| `reviews.list` | `GET /api/reviews` | None |
| `reviews.followups` | `GET /api/reviews/followup` | Required query: `pr_url` |
| `reviews.followup` | `POST /api/reviews/followup` | Body; required: `pr_url`, `question` |

Examples:

```bash
python3 skills/cortex-city-api/scripts/cortex_city_api.py reviews.followups \
  --query 'pr_url=https://github.com/example/repo/pull/42'

python3 skills/cortex-city-api/scripts/cortex_city_api.py reviews.followup \
  --data '{"pr_url":"https://github.com/example/repo/pull/42","question":"Does the timeout path have coverage?"}' \
  --confirm
```

## Field values

- Task status: `open`, `in_progress`, `in_review`, `merged`, `closed`
- Issue status: `open`, `in_progress`, `done`, `closed`
- Issue priority: `low`, `medium`, `high`; use JSON `null` to clear during update
- Runtime: `claude`, `codex`
- Permission mode: `bypassPermissions`, `acceptEdits`, `auto`, `default`, `yolo`
- Effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; runtime-specific support still applies

## Side effects and conflicts

- `issues.create` rejects an invalid priority. `tasks.create` returns HTTP 409 when its `issue_id` is already linked.
- `tasks.update` removes the task worktree when setting `status` to `merged` or `closed`.
- `issues.delete` returns HTTP 409 while the issue is linked to a task.
- `reviews.followup` runs synchronously and returns its answer or an API error.
