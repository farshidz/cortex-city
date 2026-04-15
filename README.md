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
- A local path to the repo it should work on
- A default branch
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
- `Repo Local Path`: absolute path to the local clone
- `Default Branch`: usually `main`
- `Prompt`: instructions that define how this agent should behave

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

## Tests

Run the fast library test suite:

```bash
npm test
```

Run the isolated integration suite:

```bash
npm run test:integration
```

Integration tests spin up temporary repositories, fake `codex` and `claude` CLIs, and the real orchestrator worker. The runner executes test files in parallel by default; set `INTEGRATION_TEST_CONCURRENCY=1` or use `npm run test:integration:serial` if you need a single-worker run.

## Local State

Cortex City keeps its local runtime state under `.cortex/`.

That includes things like:

- configured data
- task state
- worker state

This directory is intentionally ignored by git so local machine state does not get committed.

## License

This project is licensed under the GNU GPLv3. See [LICENSE](/Users/farshid/code/cortex-city/LICENSE) for the full text.
