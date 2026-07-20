<p align="center">
  <img src="public/logo-20260416-190413.png" alt="Cortex City logo" width="180" />
</p>

# Cortex City

Cortex City is a local control panel for managing software work through reusable agents.

The core idea is simple:

- You define one or more `agents`
- You create `tasks` for those agents
- Cortex City runs `sessions` that do the work and track the result

This project is meant to help you operate an agent workflow from one place instead of juggling prompts, branches, PRs, and session state by hand.

<img width="1399" height="480" alt="Screenshot 2026-05-07 at 5 16 59 PM" src="https://github.com/user-attachments/assets/513ecb03-ad30-42b9-8ba7-605638cbbf70" />

## Prerequisites

Before using Cortex City, make sure the host machine is set up with:

- Either `Claude Code` (available on your shell as `claude`) or `Codex` (available as `codex`). Pick the default runtime and permission mode from Settings; each task can override them when needed.
- `GitHub CLI` installed and authenticated as `gh`
- A sandboxed host environment for running the agent CLI safely

Cortex City runs the configured agent runtime (Claude or Codex) as an autonomous worker against local repositories. In practice that means the worker itself needs to run without interactive permission prompts so it can edit files, run git commands, and use the shell autonomously.

Because Cortex uses `--dangerously-skip-permissions` (Claude) or `--yolo` (Codex), you should run it inside a sandboxed environment that is already scoped and safe. The safety boundary should come from the environment around the agent, not from per-command permission prompts inside the agent itself.

## Core Concepts

### Agent

An `agent` is a reusable worker profile tied to a repository.

Each agent has:

- A unique ID
- A display name
- A GitHub repo slug
- A default branch
- An optional working directory inside the repo
- An optional Git author name and email for commits the agent creates
- An optional custom prompt
- Optional environment variables

Use an agent when you want a stable operating context for a codebase or role. For example, you might have separate agents for:

- App development
- Bug fixing
- Docs maintenance
- Review and cleanup work

Create agents from the `Agents` page.

### Task

A `task` is a specific piece of work assigned to an agent.

Each task includes:

- A title
- An assigned agent
- A description
- An optional plan
- An optional branch override

Think of a task as the unit of execution. If an agent is the worker, the task is the job.

Create tasks from `New Task`.

### Session

A `session` is a single execution of a task.

Sessions let you inspect what happened during a run. A task can have multiple sessions over time as it moves from initial work to review and follow-up runs.

From a task detail page, you can:

- Run the task now
- Kill a running session
- Open the task session view
- Open the linked PR, if one exists

### Reviewer

Cortex City uses one reviewer agent for both PRs created by Cortex tasks and other people's PRs that you are assigned to review. Task-owned reviews use the task's title, description, and plan as context, and leave actionable GitHub comments for changes the implementation agent should make. Turn off `Automatic review` on a task when you do not want its PR added to this review flow.

The reviewer uses one shared learning history across both kinds of PR. When reviewed PRs merge, retrospectives improve those learnings for future reviews. Configure the global reviewer runtime, effort, and model in `Settings`; the model field accepts any model identifier supported by the selected runtime and can be left blank to use its default.

Each review, retrospective, and follow-up runs in a fresh disposable directory under `tmp/reviews/`; Cortex City removes it when the runtime exits, including after errors and timeouts. Set `CORTEX_REVIEW_WORKSPACE_ROOT` in the web and worker service environments to place these workspaces elsewhere. An absolute path on a separately mounted or quota-limited scratch volume provides an additional containment boundary without changing the application deployment.

Initial reviews examine the full PR. When a reviewed PR receives another commit, the follow-up review instead verifies the reviewer's previous required-change findings and examines the exact diff between the previously reviewed head and the new head for significant regressions. It does not re-audit unchanged code for additional marginal findings, except when unchanged code contains a clearly critical security, data-loss, or correctness issue.

### Status

Tasks move through a small workflow:

- `open`: waiting to run
- `in_progress`: currently being worked on
- `in_review`: work is ready for review, usually with a PR attached
- `merged`: PR has been merged
- `closed`: task was closed without merging

## Typical Workflow

### 1. Create an agent

Go to the `Agents` page and define the worker you want to reuse.

You will usually fill in:

- `Agent ID`: a stable machine-friendly key
- `Display Name`: a readable name in the UI
- `Repo Slug`: `owner/repo`
- `Default Branch`: usually `main`
- `Working Directory`: relative path inside the repo, or `.` for the repo root
- `Prompt`: instructions that define how this agent should behave

Cortex City clones and fetches the repository as needed under `.cortex/repos/`.
The working directory lets agents start in a smaller subfolder of a large monorepo
without asking you for an absolute local clone path.

If the agent needs secrets or repo-specific credentials, add environment variables there as well.

### 2. Create a task

Go to `New Task` and create a work item for one of your agents.

Best practice:

- Put the outcome in the title
- Use the description for context and constraints
- Use the plan for a more explicit execution outline
- Set a branch only if you want the task to use an existing branch

Examples of good task titles:

- `Fix the auth redirect loop on login`
- `Add CSV export to the reports page`
- `Review and clean up failing PR comments`

### 3. Let the task run

Once created, the task appears in the main task list.

From there you can:

- Watch task status
- See whether a session is active
- See token and run totals
- Open the task detail page
- Open the PR when one exists

### 4. Review the result

When a task reaches review, Cortex City keeps the work visible in one place.

A task may include:

- A PR URL
- Session history
- Agent output
- Notes you add manually

Use the task page to decide whether to rerun, update, close, or merge the work.

## Automatic Triggers

The worker polls continuously and starts agent runs automatically. You do not need to manually restart an agent every time the PR changes.

An agent is triggered automatically when:

- A task is in `open` status and waiting for its initial run
- A task is in `in_review` and the PR head commit has changed
- A task is in `in_review` and new submitted review comments appear
- A task is in `in_review` and new PR conversation comments appear
- A task is in `in_review` and the review state changes
- A task is in `in_review` and CI/check status changes, including failed tests

In practical terms, that means Cortex City will pick work back up when a PR needs attention again, including cases like:

- A reviewer leaves comments
- A reviewer requests changes
- CI starts failing
- Conflicts or mergeability state changes
- Someone pushes new commits to the branch

The worker does not immediately rerun a task while checks are still pending. It waits until the PR reaches a more stable state, then decides whether another review pass is needed.

When a PR is merged or closed, Cortex City updates the task state accordingly and runs cleanup for that task's worktree.

## What To Put In An Agent Prompt

The prompt is where you define the agent's persistent behavior.

A strong prompt usually covers:

- The codebase or product area it owns
- How to set up any required development environment
- Which commands to use for install, build, lint, and test
- The quality bar it should hold
- Constraints it must respect
- Preferred testing or review behavior
- How it should report outcomes

It can also document which secrets the agent may rely on through environment variables that you attach to that agent.

Keep task-specific instructions in the task itself. Keep long-lived behavior in the agent prompt.

## What To Put In A Task

Use the three task fields differently:

- `Title`: the result you want
- `Description`: the why, context, and constraints
- `Plan`: the suggested approach, if you want to steer execution more tightly

If the agent should figure out the implementation itself, leave the plan blank and focus on a clear description.

## Running The App

Install dependencies:

```bash
npm install
```

Start the web app:

```bash
npm run dev
```

Start the worker in another terminal:

```bash
npm run worker
```

Then open `http://localhost:3000`.

If you want the web app to auto-start the worker during local development, set `CORTEX_ENABLE_WORKER_AUTOSTART=1` before starting `npm run dev`. Leave that disabled in production.

## Production Deployment

In production, run the web app and worker as separate `systemd` services. Do not rely on the web app to spawn the worker.

Typical deploy flow:

```bash
npm ci
npm run build
```

Service templates are included under `deploy/systemd/`:

- `deploy/systemd/cortex-city-web.service`
- `deploy/systemd/cortex-city-worker.service`
- `deploy/systemd/cortex-city-host-metrics.service`
- `deploy/systemd/cortex-city-disk-hygiene.service`
- `deploy/systemd/cortex-city-disk-hygiene.timer`

Recommended production model:

- `cortex-city-web.service` runs `npm run start`
- `cortex-city-worker.service` runs `npm run worker`
- `cortex-city-host-metrics.service` writes compact host diagnostics every 60 seconds
- `cortex-city-disk-hygiene.timer` runs daily cleanup for old logs and service-user caches
- all Cortex services set `TMPDIR`, `TMP`, and `TEMP` to `/opt/cortex-city/app/tmp`
  so review/build scratch files stay in a Cortex-owned temp directory instead
  of accumulating in shared `/tmp`
- the long-running web, worker, and host metrics services use `Restart=always`
- `CORTEX_ENABLE_WORKER_AUTOSTART=0`

The worker reconciles live task PIDs on every poll, so `systemd` restarts do not lose track of interrupted work or overcount parallel session slots.

The intended production user is `cortex`. Bootstrap creates that account, and deploy now defaults to installing and running the services as `cortex`.

To deploy the current checkout to a remote Linux host over SSH, use:

```bash
scripts/deploy-ssh.sh ubuntu@your-server /opt/cortex-city/app
```

The script syncs the repo to a remote staging release under `.deploy/staging/`,
runs `npm ci` and `npm run build` there while the current services keep
running, upgrades the remote Codex CLI to `@openai/codex@latest`, then
publishes the staged release, installs rendered `systemd` units, and restarts
the web, worker, host metrics, and disk hygiene timer units. By default it deploys as the
`cortex` service user created by bootstrap; override `SYSTEMD_USER`,
`SYSTEMD_GROUP`, `REMOTE_OWNER`, and `REMOTE_GROUP` if you want a different
account. Override `REMOTE_STAGING_BASE` to place staged releases somewhere else.

### Production disk hygiene

Production disk pressure is controlled in several layers:

- Reviewer launches reserve 15 GiB by default. The worker checks before every
  review, follow-up, and retrospective, then checks every five seconds while
  the runtime is active and terminates it if free space crosses the reserve.
  Set `CORTEX_REVIEW_MIN_FREE_DISK_BYTES` in `/etc/cortex-city/worker.env`
  and `/etc/cortex-city/web.env` to tune the reserve in bytes for automatic
  and manually launched reviews. Optionally set
  `CORTEX_REVIEW_DISK_CHECK_INTERVAL_MS` to tune the polling interval.
- Host metrics are compact by default: `HOST_METRICS_INTERVAL_SECONDS=60`,
  `HOST_METRICS_RETENTION_DAYS=3`, and `HOST_METRICS_MODE=compact`. Override
  these in `/etc/cortex-city/host-metrics.env` if you need a temporary incident
  window with more detail, for example `HOST_METRICS_MODE=verbose` or
  `HOST_METRICS_DETAIL_EVERY=1`.
- `scripts/cortex-disk-hygiene.sh` prunes old `logs/host-metrics-*.log`,
  `logs/server-*.log`, task session logs, npm/pnpm caches, stale
  Playwright/Puppeteer browser cache directories, and stale known-safe temp
  prefixes from `/tmp` and `/opt/cortex-city/app/tmp`. It intentionally does
  not delete `.cortex/repos/*/.worktrees`, so active task worktrees are outside
  the maintenance script's scope.
- Deploy and bootstrap create `/opt/cortex-city/app/tmp` with `0700` ownership
  for the `cortex` service user. Deploy also builds staged releases with
  `TMPDIR` pointed at the staging directory, which prevents `npm ci`/build
  scratch files from spilling into shared `/tmp`.

The script is dry-run by default:

```bash
sudo -u cortex -H /opt/cortex-city/app/scripts/cortex-disk-hygiene.sh --dry-run --app-dir /opt/cortex-city/app
```

Apply cleanup manually with:

```bash
sudo -u cortex -H /opt/cortex-city/app/scripts/cortex-disk-hygiene.sh --apply --app-dir /opt/cortex-city/app
```

Deploy installs `cortex-city-disk-hygiene.timer`, which runs the same command
daily around 03:30 with a randomized delay. Tune retention in
`/etc/cortex-city/disk-hygiene.env`:

```bash
CORTEX_APP_LOG_RETENTION_DAYS=14
CORTEX_TASK_LOG_RETENTION_DAYS=14
HOST_METRICS_RETENTION_DAYS=3
CORTEX_CACHE_RETENTION_DAYS=14
CORTEX_BROWSER_CACHE_RETENTION_DAYS=14
CORTEX_TMP_RETENTION_DAYS=2
CORTEX_TMP_DIR=/opt/cortex-city/app/tmp
CORTEX_TMP_SCAN_DIRS=/tmp:/opt/cortex-city/app/tmp
CORTEX_PRUNE_OWNED_TMP_ALL=1
CORTEX_TMP_USE_LSOF=1
CORTEX_NPM_CACHE_ACTION=clean   # clean, verify, or skip
CORTEX_PNPM_STORE_ACTION=prune  # prune or skip
```

If you do not use the included timer, schedule the apply command from cron or
another host scheduler during an off-hours window and run the dry run first.
The `/tmp` cleaner only considers entries owned by the service user and matching
known Cortex/review prefixes such as `cloud_control_plane*`, `ccp-*`,
`agentic-chat-*`, `aws-cdk-lib-review*`, `immutable_inputs*`,
`codex-schema-*`, and `node-compile-cache*`. It skips entries with recent
contents and, when `lsof` is available, entries with open files. Operators
should still watch shared `/tmp` after major runtime/tooling changes; add new
safe prefixes through the script only after confirming they are disposable
scratch data.

For first-time host setup, run:

```bash
scripts/bootstrap-ssh.sh ubuntu@your-server
```

The bootstrap script installs base packages, installs Node.js plus `gh`, `codex`, `claude`, and `wrangler`, creates the app user, sets a global git identity for that service user, prepares `/opt/cortex-city/app` and `/etc/cortex-city`, and writes starter `web.env` and `worker.env` files. It does not install nginx or any reverse proxy.

By default bootstrap also reads deploy credentials from a gitignored repo-local `.env.prod`, writes the GitHub and Cloudflare values into the remote `worker.env`, and pre-authenticates `gh` for the `cortex` service user:

```bash
cat > .env.prod <<'EOF'
GH_TOKEN=github_pat_...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
EOF

scripts/bootstrap-ssh.sh ubuntu@your-server
```

Set `BOOTSTRAP_ENV_FILE=/path/to/file` if you want a different local credentials file, or override individual values from your shell for a single run.

Bootstrap defaults the service user's git identity to `Cortex City <farshid@marqo.ai>`. Override that with `GIT_USER_NAME=...` and `GIT_USER_EMAIL=...` if a host should use a different author identity.

`codex` and `claude` still require a one-time interactive login as `cortex` when you want to use subscription-based access instead of API keys.

## Local State

Cortex City keeps its local runtime state under `.cortex/`.
It creates `.cortex/.gitignore` automatically for local-only runtime files such as `orchestrator-state.json`, `.env`, `.env.*`, and managed repo clones in `repos/`.

That includes things like:

- configured data
- task state
- worker state

This directory is intentionally ignored by git so local machine state does not get committed.

## License

This project is licensed under Apache 2.0. See [LICENSE](/Users/farshid/code/cortex-city/LICENSE) for the full text.
