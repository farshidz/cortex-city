# Review session reuse experiment

Merge and deploy the CI-scope, learnings, empty-verification, and conversation fixes before this change. Record the deployment time as the start of a one-week measurement window. Keep prompts, scheduling, learnings, and builder session reuse stable during that window.

Both groups inject a shared snapshot of curated guidance, created atomically at `.cortex/review-reuse-v1-learnings.md` on the first full-review prompt. Retrospectives continue updating the live learnings file; those edits apply after the experiment is disabled. Install curated guidance before deployment so the initial snapshot is correct.

## Assignment and sessions

Only the scheduler explicitly enrolls rounds. Manual regeneration starts fresh, uses live guidance, and is excluded from experiment aggregates.

Codex scheduled reviews use stable PR-level assignment: SHA-256 of `review-reuse-v1:<PR URL>`, first byte below 128 means reuse. The other PRs start fresh each round. The initial run in either group starts fresh. Claude reviews are recorded but excluded from this experiment. Setting `review_session_reuse_experiment` to `false` in configuration disables scheduled reuse.

The reuse group keeps a session for each resolved runtime/model/effort/tier profile and task context. Full-review and verification profiles remain separate. Reply rounds use their configured tier's session. Runtime failures retire the affected session. Context changes clear these sessions. Session cleanup protects active review sessions. Builder/task reuse remains as configured.

The interactive Q&A pointer remains separate. It can point at a scheduled full-review session; Q&A may add turns to it. All Q&A, scheduled, and manual launches acquire the same per-PR lock, so they cannot overlap. Usage measurement excludes earlier Q&A turns by selecting only the invocation's native turn IDs.

## Records and accounting

`logs/run-events-YYYY-MM-DD.jsonl` persists launch attempts, runtime starts, runtime completions, saved outcomes, and completion failures. Logs are preserved across deployment. The existing disk-hygiene timer expires run-event logs after 30 days (configurable via `CORTEX_RUN_EVENT_RETENTION_DAYS` or `--run-event-retention-days`); export the measurement files before that deadline. Each scheduled review records its run ID, PR/head/diff, launch reason, group, actual resumption, session, profile, tier/round, duration, exit/failure, usage, and deployed revision. Builder launches record the scheduling reason, PID/run identifier, task/PR, triggering GitHub state, and prior run result/session.

Codex accounting streams the session rollout and sums deduplicated native `token_usage_record.payload.usage` records for the turn IDs started by this invocation. This measures consumed requests even if a turn fails. It avoids subtracting session counters, which can reset or include intervening Q&A. Raw CLI counters and the previous scheduled baseline remain in the log for audit and reset detection. Missing/invalid native records are explicitly unknown and are excluded from token totals. They must be reported alongside measured counts; zero is not substituted for missing usage.

Usage covers the runtime thread's model requests. Independently spawned child-agent sessions are not included in these totals. Claude invocation totals include uncached input, cache reads, and cache writes; only reads count as cache hits.

## Analysis after one week

```sh
node scripts/analyze-review-usage.mjs logs START_ISO END_ISO
```

Use the actual deployment timestamp and one week later. The report separates deployed revision, assigned group, runtime/model/effort, tier, round type, initial/follow-up, and actual fresh/resumed invocation. Per-PR totals include verification, reply, and escalation sequences that start in the window. Runs that cross the window boundary are attributed by start time. Launch failures, saved results, and completion failures are terminal outcomes; runs without one remain incomplete even when runtime token usage is available. Inspect PRs whose histories began before the window separately.

Compare cached-input fraction, input/output totals per PR sequence, duration, failures, and unknown/incomplete counts. Inspect review conclusions and discussion for stale context or missed findings before deciding whether to retain reuse. These token counts do not directly measure subscription allowance consumption. No automatic analysis job is scheduled.
