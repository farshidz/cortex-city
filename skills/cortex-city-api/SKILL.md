---
name: cortex-city-api
description: Operate a running Cortex City instance through the same local HTTP API used by its UI. Use when an agent needs to inspect or manage Cortex City tasks, issues, sessions, reviews, worker state, quotas, prompts, or other UI-visible operational data at http://localhost:3001/. Supports guarded writes while prohibiting global settings, agent prompt, agent environment, and reviewer-learning modifications.
---

# Cortex City API

Use the bundled client instead of writing ad hoc `curl` commands. It provides named UI operations, validates request fields, prints JSON responses, and blocks global-settings writes.

## Run the client

Run `scripts/cortex_city_api.py` from this skill directory with Python 3. The default base URL is `http://localhost:3001/`. Override it for the current command with `--base-url` or the `CORTEX_CITY_URL` environment variable.

List supported operations:

```bash
python3 skills/cortex-city-api/scripts/cortex_city_api.py --list-operations
```

Read data:

```bash
python3 skills/cortex-city-api/scripts/cortex_city_api.py tasks.list --query status=open
python3 skills/cortex-city-api/scripts/cortex_city_api.py tasks.get --id TASK_ID
python3 skills/cortex-city-api/scripts/cortex_city_api.py orchestrator.status
```

Preview a write without sending it:

```bash
python3 skills/cortex-city-api/scripts/cortex_city_api.py issues.create \
  --data '{"title":"Investigate flaky test","description":"Collect failure patterns"}' \
  --dry-run
```

Perform a write after confirming it matches the user's intent:

```bash
python3 skills/cortex-city-api/scripts/cortex_city_api.py issues.create \
  --data '{"title":"Investigate flaky test","description":"Collect failure patterns"}' \
  --confirm
```

Use `--data-file PATH` for long JSON bodies. Use `--data-file -` to read JSON from standard input.

## Follow the operation workflow

1. Read the relevant current object before changing or deleting it. Resolve IDs from list operations when the user supplied a title or other human-readable identifier.
2. Read [references/api.md](references/api.md) for the operation name, accepted fields, enum values, and side effects.
3. Treat an explicit user request for the exact write as confirmation. Ask before a write when the target, scope, cost, or external effect is ambiguous.
4. Use `--dry-run` to inspect the method, URL, and JSON body for a complex request.
5. Add `--confirm` and execute the named operation. Report the returned object or the API error.
6. Re-read state after asynchronous operations when the user needs completion status. Poll at a modest interval and stop when the requested terminal condition is reached.

## Respect the settings boundary

Global settings are repository-wide Cortex City configuration and shared reviewer configuration. Keep them read-only.

The client permits `config.get`, `review-learnings.get`, `agent-prompt.get`, and a redacted `agent-env.get`. It blocks writes to:

- `/api/config`
- `/api/reviews/learnings`
- `/api/agents/{id}/prompt`
- `/api/agents/{id}/env`

Do not bypass this boundary with `curl`, another HTTP client, or direct file edits. `agent-env.get` replaces every environment value with `<redacted>` before printing it.

## Handle consequential operations

All writes require `--confirm`. Give extra attention to these operations:

- `tasks.create` can be picked up by the worker immediately and consume model quota.
- `tasks.delete` and `issues.delete` remove stored records. Task deletion can also remove a worktree.
- `tasks.instruct`, `orchestrator.poll`, `reviews.regenerate`, and `reviews.followup` can launch model work.
- `sessions.kill` terminates an active run.
- `reviews.submit` posts an approval, change request, or comment to GitHub.

Use only IDs and PR URLs returned by Cortex City or explicitly supplied by the user. Preserve user-authored Markdown exactly in descriptions, plans, notes, comments, instructions, and review bodies.

## Handle failures

The client exits nonzero for validation, connection, and HTTP errors. Preserve the API's status and response body when reporting a failure. Common conflicts include an active task that cannot be deleted, an issue already linked to a task, a review run already in flight, and a manual instruction already pending.
