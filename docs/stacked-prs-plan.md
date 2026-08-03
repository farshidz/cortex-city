# Stacked PRs Plan

## Goal

Allow a single Cortex City task to produce and manage a set of stacked PRs instead of exactly one PR. The bottom PR targets the agent's base branch; each subsequent PR targets the branch of the PR below it. The task tracks the whole stack through review, restacking after merges, and final cleanup.

## Decided Constraints

These were decided up front and the plan is built around them:

1. **Opt-in via task description.** No new task field or UI toggle. The prompt templates teach the agent: produce a stack only when the task description explicitly asks for stacked PRs. Otherwise behave exactly as today (single PR).
2. **One task owns the whole stack.** No child tasks, no task dependencies. The task keeps its single worktree; the agent creates and maintains all stack branches inside it, hopping branches as needed.
3. **Sync only on merge.** When a lower PR receives new commits (review feedback), upper branches are *not* cascaded — GitHub's three-dot diff against the merge base keeps upper PR diffs clean, so drift is tolerable. When a PR **merges** (typically squash merge), the agent must **restack**: retarget the next PR's base and rebase the remaining branches onto the new base so squashed-away commits don't reappear as conflicts or duplicate diffs.
4. **Each PR is reviewed independently.** The existing reviewer pipeline (keyed by `pr_url`) runs once per stack PR. Each review request carries a per-PR scope note so the reviewer judges the PR against its slice of the task, not the whole task.

## Current Architecture (what changes)

- `Task` has singular `pr_url`, `branch_name`, `worktree_path`, `pr_status`, `last_review_gh_state` (`src/lib/types.ts`).
- The agent's structured report (`AgentReport` + `AGENT_REPORT_SCHEMA` in `src/lib/agent-runner.ts`) has singular `pr_url` / `branch_name`.
- `prompts/templates/initial.md` instructs "create a pull request targeting `{{BASE_BRANCH}}`"; `review.md` is framed around one PR.
- The worker (`src/lib/orchestrator-worker-runtime.ts`) polls `task.pr_url` for merged/closed → flips the task to `merged`/`closed`; computes one PR state hash to decide review-mode runs; builds one task-owned `ReviewRequest` per task.
- The reviewer (`src/lib/review-runner.ts`, `review-store.ts`) is already keyed by `pr_url`, which stacking can reuse as-is.

## Data Model

### New `TaskStackedPR` (types.ts)

```ts
export interface TaskStackedPR {
  position: number;          // 1 = bottom of the stack
  pr_url: string;
  branch_name: string;
  base_branch: string;       // agent default branch for position 1, otherwise the branch below
  scope: string;             // one-paragraph description of the slice this PR delivers
  state: "open" | "merged" | "closed";
  pr_status?: PRStatus;              // per-PR, worker-maintained
  last_review_gh_state?: string;     // per-PR, replaces the task-level hash for stacked tasks
}
```

### Task changes

```ts
export interface Task {
  // ...existing fields unchanged...
  stacked_prs?: TaskStackedPR[];  // present only for stacked tasks
}
```

Back-compat rules:

- `stacked_prs` absent → every existing code path behaves exactly as today. All new logic is gated on `Array.isArray(task.stacked_prs) && task.stacked_prs.length > 0`.
- For stacked tasks, `task.pr_url` / `task.branch_name` **mirror the frontier PR** (the bottom-most *open* PR). The worker updates the mirror as PRs merge. This keeps every existing single-PR consumer (task list link, review prompt `{{PR_URL}}`, cleanup prompt) pointing at the currently mergeable PR without teaching them about stacks.
- `task.pr_status` becomes an aggregate for stacked tasks: the worst status among open stack PRs (ordering: `conflicts` > `checks_failing` > `unstable` > `checks_pending` > `needs_approval` > `clean`), so the task list column stays meaningful.
- `task.last_review_gh_state` is unused for stacked tasks (per-PR hashes live on the entries). `review_migration_head_sha` never applies to stacked tasks (new feature; no retired-reviewer history).
- Persistence is JSON (`tasks.json`); adding an optional field requires no migration.

### AgentReport changes

```ts
export interface AgentReport {
  // ...existing fields...
  stacked_prs?: Array<{
    position: number;
    pr_url: string;
    branch_name: string;
    base_branch: string;
    scope: string;
  }>;
}
```

`AGENT_REPORT_SCHEMA` (agent-runner.ts, shared by Claude `--json-schema` and the Codex `--output-schema` file) gains a `stacked_prs` property following the existing required-with-null convention: `type: ["array", "null"]`, added to `required`, `null` when the task is not stacked. For stacked tasks the agent still fills top-level `pr_url` / `branch_name` with the bottom PR so legacy parsing keeps working.

## Prompt Changes

### `prompts/templates/initial.md`

Add a "Stacked PRs" section:

- Only build a stack when the task description explicitly asks for stacked PRs; otherwise create a single PR as before.
- How to stack: branch 1 off `origin/{{BASE_BRANCH}}`, PR 1 targets `{{BASE_BRANCH}}`; branch K (K>1) off branch K-1, PR K targets branch K-1. Push all branches; open PRs bottom-up.
- Every PR description must open with a stack header (e.g. `Stack: PR 2/4 — <slice summary>`, links to the PRs below/above) and still end with the existing agent attribution line.
- Keep each PR a coherent, independently reviewable slice; prefer 2–4 PRs unless the task says otherwise.
- Report the full stack in the final JSON under `stacked_prs` (bottom first), and set `pr_url`/`branch_name` to the bottom PR.

### `prompts/templates/review.md`

The review run becomes the vehicle for feedback handling *and* restacking. Add a `{{STACK_SECTION}}` placeholder that `buildReviewPrompt` fills only for stacked tasks with:

- A table of the stack: position, PR URL, branch, base, state (open/merged/closed), per-PR merge status.
- Instructions:
  - Inspect feedback (all three surfaces, as already specified) on **every open stack PR**, not just the frontier. Address feedback on the branch of the PR it was left on.
  - Do **not** proactively merge lower branches into upper branches just because they changed; upper-PR diffs are computed against the merge base and tolerate drift.
  - **Restack protocol** — when the section flags that a lower PR has merged: verify/retarget the next PR's base (GitHub retargets automatically when the merged head branch is deleted; otherwise `gh pr edit <n> --base <new-base>`), then rebase each remaining branch bottom-up onto its new base with `git rebase --onto <new-base> <old-base-tip> <branch>` so squashed-away commits are dropped, and push with `--force-with-lease`. This is an explicit, restack-only exception to the "do not rebase / merge only" rule, which stays in force everywhere else.
  - Resolve rebase conflicts in-session; never open a replacement PR for an existing stack entry.
- Response format: report the current stack in `stacked_prs` (entries keep their `pr_url`; drop merged/closed entries is *not* allowed — report them with their state so the orchestrator can reconcile).

### `prompts/templates/cleanup.md`

Minor: `{{PR_URL}}` / `{{BRANCH_NAME}}` already render the frontier mirror; add an optional stack summary line so cleanup logs are accurate. Low priority.

## Agent Runner (`src/lib/agent-runner.ts`)

1. **Schema**: extend `AGENT_REPORT_SCHEMA` as above.
2. **`buildReviewPrompt` inputs**: pass the stack (entries + per-PR status + "merged below, restack required" flags) through a new options field; `prompt-builder.ts` renders `{{STACK_SECTION}}` (empty string for non-stacked tasks).
3. **`handleRunComplete`**:
   - When `report.stacked_prs` is present and the run succeeded, reconcile it into `task.stacked_prs`: match entries by `pr_url`, preserve worker-maintained fields (`state`, `pr_status`, `last_review_gh_state`) on existing entries, append new entries, never delete entries the report omits (log a warning instead).
   - Recompute the frontier mirror (`pr_url`, `branch_name`) from the reconciled stack.
   - Status transition to `in_review` triggers when the report contains either `pr_url` or a non-empty `stacked_prs` (existing logic already keys off `pr_url`, which the agent fills anyway).
4. **Pre/post-run comment snapshots**: `preRunCommentIds` becomes a per-PR map over all open stack PRs (falling back to the single `task.pr_url` as today). Post-run, capture `getPRStateHash` per open stack PR into the entries' `last_review_gh_state`; skip an entry's hash update when that entry gained mid-run comments (same rule as today, applied per PR).
5. **Worktree**: unchanged — one worktree per task; the agent checks out whichever stack branch it is working on. `ensureWorktree`'s branch derivation still only manages the task's initial branch; stack branches 2..N are created by the agent inside the worktree.

## Worker (`src/lib/orchestrator-worker-runtime.ts`)

In the `in_review` scan, branch on `task.stacked_prs`:

### Per-poll, per open stack entry

1. `isPRMergedOrClosed(entry.pr_url)` → update `entry.state`. On any newly-merged entry with open entries remaining: recompute the frontier mirror and mark the task as **restack-required** (a transient flag on the poll candidate, like `hasConflicts` today) so a review-mode run launches even when state hashes are unchanged.
2. `getPRStatus(entry.pr_url)` → `entry.pr_status`; recompute the aggregate `task.pr_status`.
3. Resolve head SHA (`getPRHeadSha`) per entry → `taskReviewHeads` (already keyed by `pr_url`).
4. Build one task-owned `ReviewRequest` per open entry (see Reviewer section), respecting the same automatic-review gating as today.
5. `getPRStateHash` per entry, compared to `entry.last_review_gh_state`; the task becomes a review-run candidate if **any** open entry's hash changed, any entry has conflicts, a manual instruction is pending, or restack is required.

### Terminal-state semantics

- All entries terminal and **all merged** → task `merged`.
- All entries terminal and **any closed without merging** → task `closed` (the stack was at least partially abandoned; a human should look). Flagged as a proposal — see Open Questions.
- Any entry still open → task stays `in_review`.
- On terminal transition, clear `pr_status` and let the existing cleanup pipeline (`final_cleanup_state`, cleanup run, worktree finalize) proceed unchanged. Stack branches 2..N live only on the remote and in the shared repo clone; the existing worktree removal covers the worktree, and merged PRs' branches are deleted by the agent during restack (see prompt) or by GitHub's delete-on-merge if enabled.
- Edge case — a stack PR merged *into its stacked base* (someone merged PR K down into branch K-1 rather than waiting): `isPRMergedOrClosed` reports `merged` regardless of base. Treat the entry as merged; the next restack run reconciles branches. Document this in the stack section so the agent understands the state it sees.

### Guarding

- `shouldDeferBuilderForStoredReview` runs per open entry; the builder defers if **any** open entry's review is running or stale in the ways it checks today.
- `activeReviewPids` / review store are already per-`pr_url` — no changes needed for parallel reviews of different stack PRs. `max_parallel_reviews` naturally throttles them.

## Reviewer (`src/lib/review-runner.ts`, `review-store.ts`, `types.ts`)

1. `ReviewRequest` gains optional fields:

```ts
task_stack_position?: number;  // 1-based
task_stack_size?: number;
task_pr_scope?: string;        // the entry's scope text
```

2. `taskReviewRequest(...)` (worker) fills them from the stack entry; non-stacked requests omit them (store normalization already tolerates unknown/absent fields — verify and extend `review-store` field copying like the existing `task_*` fields).
3. `buildTaskReviewContext` (review-runner.ts) appends, when present:

> This PR is slice {position}/{size} of the task. Its scope: `<task_pr_scope>`. It targets an intermediate stack branch; PRs above it deliver the remaining slices. Judge completeness and scope against this slice only — do not require the rest of the task's plan to appear in this diff, and do not flag work that belongs to another slice as missing or out of scope.

4. Everything else (follow-up reviews on new heads, retros, workspace lifecycle, reviewer comment delivery) is keyed by `pr_url` and works per stack PR without change. GitHub computes each stacked PR's diff against its base branch, so the review workspace sees exactly the slice.

## UI

1. **Task detail page** (`src/app/tasks/[id]/page.tsx`): when `stacked_prs` is present, render a "PR Stack" list — position, scope, PR link, per-PR state/status badge — in place of (or above) the single PR link.
2. **Task list** (`src/app/page.tsx`): the existing PR link keeps working via the frontier mirror; add a small `k/N merged` badge for stacked tasks.
3. **API**: `/api/tasks` already serializes whole task objects; `stacked_prs` flows through without route changes.

## Implementation Phases

Each phase is landable and independently testable; earlier phases don't regress single-PR tasks.

1. **Types + report plumbing.** `TaskStackedPR`, `Task.stacked_prs`, `AgentReport.stacked_prs`, schema update, `handleRunComplete` reconciliation + frontier mirror. `initial.md` stacked-PRs section. After this phase a task can *create* a stack and the task record tracks it (worker still only watches the frontier PR — acceptable interim behavior since the mirror keeps it valid).
2. **Worker stack polling.** Per-entry merged/closed, status, hashes, review-run candidacy, restack-required trigger, terminal-state semantics, aggregate `pr_status`, per-PR pre/post-run comment snapshots.
3. **Restack + review prompt.** `{{STACK_SECTION}}` rendering in `prompt-builder.ts`, `review.md` stack/restack protocol, `buildReviewPrompt` options threading.
4. **Reviewer scope.** `ReviewRequest` fields, worker request building per entry, `buildTaskReviewContext` slice framing, review-store normalization.
5. **UI.** Task detail stack list + task list badge.

## Testing

Mirror the existing test layout:

- `agent-runner.unit.test.ts` / `agent-runner.test.ts`: schema shape; report reconciliation (new entries, preserved worker fields, omitted entries warn-not-delete); frontier mirror updates; per-PR hash capture and mid-run-comment skip.
- `prompt-builder.test.ts`: stack section rendering (empty for non-stacked; table + restack flag for stacked), initial template placeholders.
- `orchestrator-worker-runtime.unit.test.ts` + harness tests: per-entry merged detection → restack candidacy; all-merged → `merged`; closed-without-merge → `closed`; any-entry hash change → review run; aggregate `pr_status`; review requests per open entry with scope fields; defer logic across entries.
- `review-runner.test.ts` / `review-store.test.ts`: slice context injection; store round-trip of the new request fields; legacy records unaffected.
- `pages.test.tsx`: stack list rendering and `k/N merged` badge.

## Open Questions / Proposed Defaults

Non-blocking; the plan proceeds with the proposal unless overridden:

1. **Closed-without-merge terminal status.** Proposal: task → `closed` when the stack ends with any unmerged-closed PR. Alternative: `merged` if at least one PR merged.
2. **Frontier mirror vs. stable bottom PR.** Proposal: `task.pr_url` tracks the bottom-most open PR (most useful link, keeps legacy consumers pointed at the mergeable PR). Alternative: freeze it at PR 1 forever.
3. **Restack execution.** Per the decided constraint this is agent-driven via a review-mode run. If restack reliability disappoints in practice, a later hardening step could move the deterministic parts (retarget + `rebase --onto` + lease push) into the worker and only hand conflicts to the agent — the restack-required trigger built in Phase 2 is the natural seam for that.
4. **Stack size guidance.** Proposal: prompt suggests 2–4 PRs unless the task description specifies a structure. No hard cap enforced in code.
