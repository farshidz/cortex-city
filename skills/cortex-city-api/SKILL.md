---
name: cortex-city-api
description: Operate a running Cortex City instance through a restricted subset of the local HTTP API used by its UI. Use when an agent needs to list, inspect, create, or update tasks; manage issues; or list reviews and ask review follow-up questions at http://localhost:3001/. Supports guarded writes while excluding session, worker-control, review-submission, review-regeneration, configuration, and status operations.
---

# Cortex City API

Use the bundled client instead of writing ad hoc `curl` commands. It provides a restricted set of named UI operations, validates request fields, and prints JSON responses.

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
python3 skills/cortex-city-api/scripts/cortex_city_api.py reviews.list
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

## Respect the operation boundary

Use only operations listed by `--list-operations`. The client excludes:

- task deletion, manual instructions, and session transcripts
- active-session and worker-control operations
- review regeneration and GitHub review submission
- all configuration, prompt, environment, learning, quota, and status operations

Do not bypass this boundary with `curl`, another HTTP client, or direct file edits.

## Handle consequential operations

All writes require `--confirm`. Give extra attention to these operations:

- `tasks.create` can be picked up by the worker immediately and consume model quota.
- `tasks.update` can remove a worktree when it sets the task status to `merged` or `closed`.
- `issues.delete` removes a stored issue.
- `reviews.followup` can launch model work.

Use only IDs and PR URLs returned by Cortex City or explicitly supplied by the user. Preserve user-authored Markdown exactly in descriptions, plans, notes, comments, and review questions.

## Handle failures

The client exits nonzero for validation, connection, and HTTP errors. Preserve the API's status and response body when reporting a failure. Common conflicts include an issue already linked to a task and an issue that cannot be deleted while linked.
