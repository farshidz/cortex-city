# Unified Reviewer Agent Plan

## Goal

Use Cortex City's stronger review agent for:

- pull requests created by Cortex tasks;
- other people's pull requests that the user has been asked to review; and
- pull requests carrying the `cortex-city-review` label, including self-authored PRs that are not linked to a Cortex task.

Retire the older task-specific reviewer, while preserving the implementation agent's separate responsibility for responding to review comments, CI failures, and other PR feedback.

Add one global reviewer model setting so the user can select GPT-5.6 or provide any other model identifier supported by the chosen runtime.

## Product Decisions

- There will be one review engine, prompt policy, learning store, runtime profile, and review concurrency pool.
- Task-owned and assigned PRs remain distinct workflow sources. They share review behavior but retain source-appropriate actions and presentation.
- A live Cortex task takes precedence when its PR is also selected by `cortex-city-review`; the label does not bypass task pause, automatic-review opt-out, or builder-coordination rules.
- The existing per-task reviewer on/off choice remains as an **Automatic review** opt-out. It controls whether a task PR enters the unified review queue; it does not select a different reviewer.
- Settings defines the default reviewer runtime, model, and effort. The reviewer model is Settings-only; existing per-review runtime and effort overrides can remain. A task's runtime, model, and effort continue to configure its implementation agent only.
- The Reviews area explicitly filters by review source. Clean inbound PRs from other authors are approved automatically at the reviewed SHA, while human-decision cases remain visible and receive a top-level PR conversation prompt. Task-owned results remain associated with the task workflow and GitHub feedback, where self-approval actions and inbound-review wording do not apply.
- Required changes found on a task-owned PR are left as GitHub comments. The implementation agent continues to detect and address that feedback through its existing PR-feedback workflow.

## Target Architecture

All three sources feed a shared review queue, deduplicated by PR and commit:

```text
Task-owned PRs -----------+
Assigned/reviewed PRs ----+--> Unified reviewer --> Source-specific handoff
Labeled PRs --------------+          ^
                                    |
                      Global reviewer settings
                      + accumulated learnings
```

Each review target carries enough source context to apply the right policy:

- A task-owned target is linked to its Cortex task and includes the task's goal and plan as review context.
- An assigned target retains the human-review state and actions needed by the Reviews experience.
- A PR that is visible through more than one source still receives only one automatically scheduled review for a given head commit.

The unified reviewer owns review execution, summaries, verdicts, follow-ups, errors, and learning history. The task workflow owns implementation work and the response to actionable feedback.

## Delivery Plan

### 1. Establish a common review target and policy

- Generalize the stronger review agent so it can review either an assigned PR or a task-owned PR without assuming that the signed-in user is always the reviewer.
- Carry source and task linkage through review state so lifecycle, labels, and available actions can be source-aware.
- Preserve the stronger agent's structured verdicts, automatic re-review of new commits, GitHub comments for required changes, follow-ups, and accumulated learnings.
- Include task title, description, and plan when reviewing a task-owned PR so the unified reviewer can assess both code quality and whether the implementation satisfies the task.

### 2. Route task-owned PRs into the unified review lifecycle

- Add eligible, in-review Cortex task PRs to the shared queue rather than relying on GitHub's assigned-review search, which does not represent self-authored task PRs. Preserve the current paused-task and automatic-review opt-out behavior when deciding eligibility.
- Use the review concurrency pool and global reviewer configuration for both PR sources.
- Coordinate the reviewer and implementation agent on the same PR: do not run them against the same head concurrently, and do not start duplicate automatic reviews for one head. Deliberate regeneration and recovery after failure remain possible.
- After a task review finishes, allow its actionable GitHub comments to wake the existing implementation feedback loop. A clean review should settle without causing a builder/reviewer loop.
- Keep reviewer-authored human-decision prompts distinct from implementation
  feedback. Posting that prompt must leave a task waiting for the human, while a
  later human PR response still wakes the implementation feedback loop.
- Keep review scheduling independent of task execution capacity so reviews are not starved when implementation session slots are full.

### 3. Extend learning and lifecycle handling to task PRs

- Apply the same accumulated review learnings to task-owned and assigned PRs.
- When a reviewed task PR merges, run the same retrospective process that compares the review with the final result and improves future review guidance.
- Make finalization and retention source-aware so a task review is not treated as closed merely because it is absent from the assigned-review query.
- Keep one canonical review record per PR, with clear linkage back to a task where applicable.

### 4. Add a global reviewer model control

- Reuse the reviewer-model configuration and runtime support already present underneath the UI; the main product gap is exposing and managing it in Settings.
- Consolidate reviewer configuration in Settings around prompt, runtime, model, effort, learning, and concurrency.
- Add an editable global **Reviewer model** control beside runtime and effort. It should suggest useful values such as GPT-5.6 while accepting arbitrary model identifiers rather than enforcing a static allowlist.
- Treat the default runtime, model, and effort as one coherent reviewer profile. Changing the default runtime must clear or flag an incompatible model choice rather than silently sending it to the wrong CLI.
- Preserve the existing per-review runtime and effort override behavior. When a run overrides the default runtime, use that runtime's appropriate fallback model rather than blindly applying a model selected for a different runtime.
- Define an empty value as an intentional fallback to Cortex's default model for the selected runtime, and then to the CLI default when no runtime default is configured. Make saving, clearing, and reloading that choice reliable.
- Snapshot the resolved runtime/model/effort profile when a review session starts. Follow-ups keep that profile for session continuity; a later review starts fresh when the newly resolved profile no longer matches the saved session.
- Apply the resolved reviewer model consistently when starting automatic reviews, re-reviews, and learning retrospectives. Treat model suggestions as guidance because actual availability is determined by the local CLI and account, and surface unsupported-model failures clearly.

### 5. Retire the legacy task reviewer safely

- Remove the old task-only reviewer execution path, its dedicated prompt/configuration, session bookkeeping, scheduling rules, and reviewer-specific usage state.
- Preserve the implementation agent's similarly named but separate PR-feedback mode; it is still required to fix review findings and CI issues.
- Preserve existing custom task-reviewer instructions as task-owned review context. Fold only guidance that is deliberately judged universal into the shared base prompt, so task-specific rules do not leak into reviews of other people's PRs.
- Normalize legacy task state during rollout so pending reviewer flags, interrupted reviewer runs, or stale process metadata cannot block implementation work.
- Enrol existing in-review task PRs into the unified reviewer once, without duplicating reviews or comments already in progress.

### 6. Align the user experience and documentation

- Rename task controls and labels to make the boundary clear: task model settings configure the implementation agent, while Automatic review uses the global reviewer profile.
- Ensure any task-owned review activity shown in existing task/session views uses labels appropriate for a PR author rather than actions such as approving their own PR.
- For assigned PRs, automatically approve the exact reviewed SHA when the
  reviewer returns a clean verdict, unless the signed-in user already has a
  current change request. When judgment is needed, post a signed PR comment and
  keep the manual approval/request-changes actions available as fallbacks.
- Never auto-approve self-authored or task-owned PRs. When one is otherwise
  ready to approve, post a signed handoff comment explaining that the review is
  clean and asking for an eligible non-author reviewer, or another manual merge
  or coordination decision when repository policy permits.
- Update product documentation to describe one reviewer, its two sources, its learning loop, and the global runtime/model/effort settings.

## Validation and Rollout

Roll out the shared task entry point before deleting the legacy path, with guards that ensure only one of them can review a PR. Remove the legacy path once the shared handoff is verified.

Validation should cover these outcomes:

- An eligible task PR and an assigned PR are both governed by the same base review policy, reviewer configuration, and learning context, with source-aware prompt context and actions.
- Automatic scheduling reviews each PR head at most once, including when task and GitHub state change during a run, while still allowing deliberate regeneration and safe retries.
- Task-owned findings wake the implementation feedback loop; clean reviews do not create repeated runs.
- Assigned-PR follow-ups, manual decision fallbacks, and status presentation do
  not regress as clean reviews gain automatic approval and advisory reviews gain
  a PR-level human-decision prompt.
- Merged task PRs participate in the learning retrospective before review data is retired.
- The global model value persists, can be cleared, accepts GPT-5.6 and arbitrary future identifiers, and is used by compatible new review sessions while existing sessions preserve their saved profile.
- Switching reviewer runtime cannot accidentally reuse an incompatible model selection.
- Existing tasks with legacy reviewer state upgrade without becoming stuck or spawning the retired reviewer.

## Out of Scope

- A per-task or per-PR reviewer model picker.
- A combined inbox that mixes task-owned PRs into the assigned-PR Reviews list.
- Replacing the implementation agent's PR-feedback and CI-remediation workflow.
- Maintaining a complete, hard-coded catalog of models supported by external CLIs.
- Broadening automatic review to every PR authored by the user; self-authored PRs still require either Cortex task ownership or the `cortex-city-review` label.
