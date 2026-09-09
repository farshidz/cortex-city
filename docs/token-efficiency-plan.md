# Token efficiency work

Updated: 2026-09-09. The work list is approved for implementation in separate PRs. Each PR requires Cortex City review and passing checks before merge. Deploy the prompt and scheduling changes before starting the reuse experiment.

## Work list

| Item | Status | Scope and acceptance criteria |
| --- | --- | --- |
| Record launch reasons | Agreed | Persist the scheduling reason, task/PR, run identifier, triggering GitHub state, and previous run result. Cover builder and scheduled reviewer launches. Records must support reconstructing why the same work ran again. |
| Run a 50/50 review-session reuse experiment | Agreed | Assign PRs consistently to reuse or fresh sessions. The reuse group retains compatible sessions per runtime/model/effort/tier and starts fresh when none exists. Record assignment and actual reuse separately. Keep builder reuse unchanged. |
| Record complete review usage | Included in experiment | Record every round's input, cached input, output, duration, runtime/model/effort/tier, and failure outcome. Preserve session identifiers and counter baselines; detect counter resets and avoid summing cumulative usage as per-round usage. Include verification and escalation rounds in comparisons. |
| Skip verification when no findings remain and a full review is required | Added to the fix list | Go directly to the required full review when there is nothing for the verification tier to check. Confirm absence across inline findings, review bodies, and PR-level findings; an empty unresolved-inline-thread list alone is insufficient. Detailed design pending. |
| Stop reprocessing already-handled conversation | Approved for implementation | The timestamp-based record of seen conversation causes repeat reply rounds. Evidence and proposed direction are below. Preserve comments that arrive during a run but were not handled. |
| Bound and curate injected review learnings | Approved for implementation | Enforce a token budget, shorten lessons, and select relevant guidance. Current full-review prompts include the entire learnings file. Keep this fixed during the reuse experiment so it does not distort the comparison. |
| Stop builders creating out-of-scope CI subtasks | Agreed: prompt-only change | Tell builders to fix CI failures related to or caused by the PR and report the rest. Replace the instruction to create tasks for unrelated failures and align the other CI wording. No task-creation gate or existing-session changes. |

Implement CI scope, learnings, and scheduling fixes before activating the reuse experiment. Keep scheduling and prompts stable during the comparison; separate measurement windows by deployed version if further changes are necessary.

## Reuse experiment

- Compare one week of production traffic starting at deployment, not the date of this document.
- PR-level assignment is approximately 50/50; individual round counts need not be equal.
- Initial runs in the reuse group still start fresh. Report these separately from actual resumptions.
- Compare cached-input fraction and total input/cached/output usage per PR review sequence, including all follow-up and escalation rounds. Also compare duration and failures, stratified by tier/round type.
- Inspect review outcomes for stale conclusions or missed feedback before deciding whether to retain reuse.
- Subscription allowance savings cannot be inferred directly from API token prices.
- Do not change prompts, learnings, builder reuse, or scheduling during the measurement window.
- Experiment activation and the analysis date are not yet set. No automatic follow-up has been scheduled.

## Reply-trigger investigation

The scheduler compares the newest non-reviewer comment/review timestamp against `last_conversation_seen_at`. On successful completion, the runner sets that field to **run start minus 60 seconds**, regardless of which comments the agent actually handled.

Relevant code:

- `src/lib/github.ts`: `getLatestForeignCommentAt` collects published non-reviewer conversation timestamps.
- `src/lib/orchestrator-worker-runtime.ts`: `hasUnansweredConversation` compares that timestamp with `last_conversation_seen_at`.
- `src/lib/review-runner.ts`: `REVIEW_CONVERSATION_SEEN_SKEW_MS` and the completion update subtract one minute from the run start.

### Confirmed pre-start overlap

PR [cloud_control_plane#5359](https://github.com/marqo-ai/cloud_control_plane/pull/5359), September 8 UTC:

| Event | Time |
| --- | --- |
| New question posted | 08:59:03 |
| Reply run started | 08:59:24 |
| Reviewer answered the question | 09:00:44 |
| Conversation recorded as seen through | Approximately 08:58:24 |
| Another reply run started on the same question | 09:01:41 |

The second run reported that the question was already answered and posted nothing. It consumed 61,618 input tokens. [Question](https://github.com/marqo-ai/cloud_control_plane/pull/5359#discussion_r3956141411), [answer](https://github.com/marqo-ai/cloud_control_plane/pull/5359#discussion_r3956155384).

The same overlap appears in cloud_data_plane#1524. It also caused a second pass over an acknowledgement on cloud_control_plane#5409: the first pass chose not to reply, and the second pass replied to the same acknowledgement.

### Conversation handled during a run

PR [cloud_control_plane#4382](https://github.com/marqo-ai/cloud_control_plane/pull/4382), September 8 UTC:

- Full review ran approximately 00:29:23–00:47:28.
- Another reviewer submitted approval at 00:43:40.
- Cortex City's 00:46:16 update explicitly incorporated that approval.
- Completion still recorded conversation as seen only through approximately 00:28:23.
- A reply round started at 00:47:50 and reported no new conversation to answer. It consumed 187,716 input tokens.

[Approval](https://github.com/marqo-ai/cloud_control_plane/pull/4382#pullrequestreview-5136184822), [Cortex City update incorporating it](https://github.com/marqo-ai/cloud_control_plane/pull/4382#issuecomment-5577354490).

Across the 17 completed reply rounds examined, the newest qualifying conversation fell within the preceding run's one-minute pre-start overlap in 4 cases, during that run in 8 cases, and after it in 5 cases. These classifications reconstruct timing from scheduler/session logs and GitHub history; historical scheduler snapshots were not persisted. Arrival during a run does not itself prove the agent handled a comment. The examples above establish actual reprocessing.

Not every no-reply outcome is a scheduling defect. Some new comments only acknowledge a finding. A new unprefixed comment from the shared `farshidz` account also legitimately counts as external conversation under the current attribution rules; its authorship cannot be inferred from the account alone.

### Proposed fix direction

Track the actual conversation items consumed or handled by each round, using identifiers that distinguish inline comments, PR comments, and review bodies. Preserve a version/body hash if edits should count as new input. Capture the initial input snapshot and explicitly acknowledge additional items handled during execution.

Schedule a reply only when relevant items remain unhandled. A round that decides an acknowledgement needs no reply should still mark that item handled. Failed rounds must not acknowledge unprocessed input.

Do not simply move the timestamp to run completion: that could suppress a comment arriving after the agent's last read. Removing the one-minute overlap alone would not fix the during-run cases. Use comment versions to preserve edits and late-arriving feedback.

## Two-tier baseline

Window: sessions started September 7–9, completed by September 9 at 04:21 UTC, and matched to scheduler launches. Tier 1 uses medium effort; tier 2 uses xhigh effort. Raw input totals include cached input.

| Completed work | Count | Input tokens | Cached input | Output tokens |
| --- | ---: | ---: | ---: | ---: |
| Tier-1 verification | 25 | 14,756,213 | 13,611,648 | 106,986 |
| Tier-1 replies | 17 | 1,887,014 | 1,585,024 | 22,757 |
| Tier-2 full review | 21 | 93,854,251 | 90,501,888 | 389,207 |

- Verification outcomes: 12 still needed author changes, 12 verified fixes and requested a full review, and 1 escalated. Thus 48% stopped before an immediate full review.
- Ten completed verification/full-review pairs consumed 3.91M input tokens in verification before 22.06M in full reviews. Verification added about 18% raw input on those paths.
- Thirteen reply rounds reported that no GitHub reply was needed, consuming 1.28M input tokens. This includes valid decisions on new acknowledgements as well as reprocessing.
- Keep the two-tier design. These observations support useful filtering but do not establish exact net savings against a controlled single-tier baseline.

## Other evidence and deferred proposals

- Production learnings contain 142,110 characters. They accounted for about 94% of one 151,510-character full-review prompt. The retrospective limits lesson count but does not enforce a token budget.
- Keep builder/task session reuse. Observed resumed first requests had cache hits around 98%; no controlled evidence currently justifies a blanket reset policy.
- Resetting old/oversized builder sessions with a concise handoff remains deferred pending evidence.
- Usage-limit cooldown and generic transient-failure backoff were withdrawn as token-efficiency priorities. Inspected usage-limit failures did not establish token waste, and no other concrete transient-failure example justified the proposal.
- A separate unchanged-blocker suppression mechanism was withdrawn. The existing GitHub-state gate already handles unchanged PRs; historical repeated builder launches were associated with the CI-hash inconsistency fixed in deployed commit `a8d56f7` on September 6.
- The earlier age/context-size rules for selective reviewer reuse were superseded by the 50/50 experiment.

## Out-of-scope builder subtasks

Production inspection on September 9 found 16 retained tasks, including 10 child tasks. Nine child tasks are paused, and five have a parent that is itself a retained child task. Paused status alone does not establish whether a task was unnecessary; the descriptions and creation policy establish the scope-expansion mechanism.

Examples:

- `Fixed dependency audit failure.` → `Fix Console merchandising E2E` → `Stabilize merchandising E2E cleanup` → `Restore staging canary data`.
- `Fix pnpm audit CI baseline` created both `Update pnpm audit CLI pin` and `Restore staging CI health`.
- The merchandising task explicitly says the failure also reproduces on unrelated PRs and main. The canary task describes shared staging data affecting several unrelated PRs.

### Cause

The production agent instruction at `.cortex/prompts/agents/marqo-agentic-swe.md:19` says:

> Do not make large changes that are out of scope for the task to fix CI failures. Instead, create a new task to address these.

The builder is following an explicit instruction to move unrelated work into new tasks. Additional contributors:

- `src/lib/prompt-builder.ts` describes failing checks as “Checks are failing — fix CI during this run,” without a scope qualifier.
- `prompts/templates/review.md` defines completion in terms of addressing all comments and CI issues, without distinguishing unrelated failures.
- `src/lib/agent-runner.ts:createFollowupTasks` turns valid follow-up requests into `open` tasks, enables their reviewer, and inherits runtime/model/effort.

### Agreed change

Replace the CI instruction with:

> Fix CI failures related to or caused by this PR. Report unrelated failures in your final summary without fixing them or creating subtasks for them.

Align the other builder CI wording with this instruction. This is a prompt-only change; no task-creation gate, changes to existing sessions, or changes to other follow-up workflows are planned. The shared prompts are updated in this PR. After merge, replace the conflicting instruction in the production agent prompt with the same sentence; that runtime configuration is excluded from repository deployment.
