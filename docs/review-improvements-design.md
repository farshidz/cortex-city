# Review Pipeline Improvements — Implementation Design

Implements the agreed next steps from `docs/review-convergence-assessment.md` (that doc
holds the evidence and rationale; this one is self-contained for implementation). Each
PR below is independently shippable, with explicit dependencies, touched surfaces, and
acceptance criteria.

## Design principles

1. **Prompts set behavior; code sets limits.** A behavioral instruction gets a
   mechanical backstop wherever one exists: restricted verdict spaces, scheduling
   gates, budgets. The convergence cap in PR 1 is the deliberate exception — it is
   prompt-only, and the state-backed findings ledger described there is the fallback
   if it degrades.
2. **Fail toward escalation.** Any ambiguity in a cheap path (unknown status, timeout,
   uncertainty) resolves to running the expensive path — never to skipping review.
3. **Builder cooperation is an optimization, never a dependency.** External builders
   (label-triggered PRs) get the same guarantees via GitHub-native signals.
4. **No terminal verdict from a cheap tier.** `ready_for_human_approval` requires a
   full tier-2 pass at the current effective diff.

## PR breakdown

| # | PR | Assessment items | Depends on | Risk |
|---|---|---|---|---|
| 1 | Reviewer prompt overhaul (convergence rule, root-invariant reports, verification mode) | 1, 2, 3 | — | low |
| 2 | Fresh sessions for scheduled reviews | 6 | 1 | low |
| 3 | Receipt all reviewer-authored comments | 4 | — | low |
| 4 | Diff-identity scheduling, debounce, reply rounds | 7 | 3 | medium |
| 5 | Tiered reviewer with per-tier model/effort settings | 5 | 1, 2 | medium |

Seven assessment items map to five PRs because items 1–3 are all edits to the same
prompt builder (`buildReviewWrapperPrompt`) and ship as one change. Suggested order:
1 → 2 → 3 → 4 → 5.

---

## PR 1 — Reviewer prompt overhaul

**Goal:** encode convergence and reporting rules in the reviewer prompt. This is the
cheap experiment: watch for prompt-only convergence degrading (decisions re-asked,
families redefined to dodge the cap, capped families reopened) — a state-backed
findings ledger is the deliberate fallback if that happens, and is out of scope here.

**Changes** (all in `buildReviewWrapperPrompt`, `src/lib/review-runner.ts` ~L486-693):

1. *Family tracking + variant cap.* New prompt block:
   - Group findings by root cause ("family"). A new blocking finding requires a
     materially distinct root cause, or a regression introduced by the latest fix.
   - When unsure whether a finding is a new family or a variant of an existing one,
     treat it as a variant — novelty is the claim requiring justification. (A wrong
     merge still surfaces in the residual-risk summary; a wrong new family restarts
     the loop.)
   - Count variants per round, not per case: sibling cases reported together in one
     finding are one variant, so the cap never limits the same-round sweep in item 2
     and never fires on a family's first report.
   - Once three separate rounds have each reported a new variant of one family, stop
     reporting further variants; convert the family to residual risk by replying on
     its existing threads and putting the remaining risk in the generated
     `## Human Decision` section, and set `needs_human_decision` once. The reviewer
     posts no top-level conversion comment of its own — Cortex City owns the single
     receipted human-decision event. Never re-raise a family a human has ruled on.
2. *Root-invariant initial reports.* Initial reviews must report the broken rule, not
   one example: state the violated invariant, test the obvious sibling cases in the
   same round, list them in one finding, and request the fix at the level of the rule
   plus a regression table.
3. *Verification-mode follow-ups.* Follow-up block (~L653-676) rewritten: enumerate
   your prior findings from GitHub threads, verify each (run the recorded repros at
   the new head), then report the outcome on the surface the finding was posted on —
   reply on an inline thread and resolve it only when the finding is fixed at the
   current head; answer a PR conversation comment, which has no thread and cannot be
   resolved, with a new top-level comment and owe no resolve for it. New discovery is
   limited to the delta and gated by rule 1. Restore the instruction removed in #84
   (`7c6ea2e`): use GitHub tooling to inspect your prior reviewer comments and review
   threads.
4. *Human-decision hygiene.* Before raising `needs_human_decision`, check whether the
   same question was already asked on this PR (search your own prior comments); if
   answered, treat the answer as binding scope.

**Acceptance criteria:**
- Prompt snapshot tests updated (`review-runner.test.ts` has wrapper-prompt coverage).
- Manual: on a test PR with a seeded multi-variant defect class, the initial review
  reports one family-level finding with sibling cases, not N single-example findings.

**Out of scope:** any state/schema change; scheduling changes.

---

## PR 2 — Fresh sessions for scheduled reviews

**Goal:** scheduled review runs never resume CLI sessions (measured: resume captures no
cache savings — 73% of resumed rounds start >15min cold, re-warm tax ≥ fresh-session
re-read cost — and compaction makes carried memory lossy). Resume stays for interactive
Q&A followups only, where gaps are short and the conversation is genuinely continuous.

**Changes** (`src/lib/review-runner.ts`):
- `resumeSessionId` selection (~L1119-1122): never resume for scheduled reviews
  (initial or follow-up). Keep resume in the `askFollowup` path (~L1807-1831) only.
- Seed every scheduled follow-up with the stored `summary` (already persisted per
  head in the review row; `askFollowup` already injects it — reuse that pattern) plus
  the PR 1 instruction to reconstruct findings from GitHub threads.
- `isReviewSessionCompatible` (~L275-290) and session wiping on context change
  (`orchestrator-worker-runtime.ts` ~L1674-1720): simplify — `session_id` is retained
  only for Q&A continuity, never consulted for scheduling.
- Delete the resume-failed fallback prompt branch (~L1276-1284); its text becomes part
  of the standard follow-up prompt (PR 1 item 3).

**Acceptance criteria:**
- No scheduled run passes `resume`/`--resume` to the runtime (assert in runner tests).
- Q&A followups still resume when profile-compatible.
- Follow-up wrapper prompt contains the stored summary.

**Risk note:** must land after or with PR 1 — fresh rounds without the reconstruction
instructions review blind.

---

## PR 3 — Receipt all reviewer-authored comments

**Goal:** reviewer-posted comments stop mutating the PR state hash (today only the two
handoff comments are receipted), so they neither wake Cortex-owned builders
(`orchestrator-worker-runtime.ts` ~L1369-1377) nor register as "new conversation" for
the reviewer itself (needed by PR 4).

**Changes:**
- `src/lib/review-comments.ts` / `src/lib/types.ts` (~L347-387): generalize
  `reviewer_comment_receipts` to record every comment ID the reviewer posts (finding
  comments, replies, summaries). The reviewer already posts via `gh` inside the run —
  capture IDs by listing comments authored during the run window with the reviewer
  prefix (`REVIEWER_GITHUB_COMMENT_PREFIX`, prefix match is the fallback for IDs the
  run failed to record).
- `src/lib/github.ts` (~L105-112, 427-501): exclude all receipted/prefixed reviewer
  comments from `getPRStateHash`.

**Acceptance criteria:** posting a reviewer comment does not change `getPRStateHash`;
builder tasks are not woken by reviewer-only activity (integration test exists for
state-hash wakeups in `orchestrator-worker.integration.test.ts` — extend it).

---

## PR 4 — Diff-identity scheduling, debounce, reply rounds

**Goal:** stop re-reviewing when the effective diff didn't change (measured: stack
rebases caused ~180M raw tokens of silent re-review in one day, because head SHA is
the only scheduling signal), while adding a first-class trigger for conversation.

**Changes** (`src/lib/orchestrator-worker-runtime.ts` `runReviewPhases` ~L1549-2092,
`src/lib/github.ts`):

1. *Effective-diff identity.* Compute a patch identity for `base...head` (aggregate
   `git patch-id --stable`, or hash of the diff with hunk headers normalized). Store
   as `effective_diff_hash` on the review row. The scheduling gate (~L1768-1778)
   triggers a **review round** only when `effective_diff_hash` changed — not on head
   SHA alone. Store `summary_diff_hash` alongside `summary_head_sha`.
2. *Debounce.* A changed diff hash schedules a review only after the head has been
   stable for a configurable window (`review_debounce_seconds`, default 300). Stacked
   PRs (#94) share the debounce: any movement in the stack resets the window for all
   its PRs.
3. *Reply rounds.* New trigger: unreceipted comments by others newer than
   `last_conversation_seen_at` (needs PR 3), with unchanged diff hash → schedule a
   **reply round**: prompt scoped to responding on existing threads; no re-review, no
   new findings; if conversation surfaces something material, emit `escalate` (see
   PR 5 statuses; pre-PR 5, emit `needs_human_decision` as the conservative mapping).
   Reply rounds run tier 1 once PR 5 lands.
4. *Verdict lifetime fix (small but load-bearing).* On diff-hash-unchanged head moves
   (rebases), do **not** clear `agent_review_status` (upsert ~L1665-1687). A pending
   `needs_human_decision` survives until answered or the diff actually changes.

**Acceptance criteria:**
- Rebase-without-diff-change schedules no review round (unit test on the gate).
- Comment-only activity schedules a reply round, not a review round.
- A `needs_human_decision` verdict survives a rebase.

**Risks:** patch-id must ignore base-drift noise (rebases changing context lines change
patch-ids; use `--stable` and normalize). If diff identity proves flaky, fall back to
comparing `gh pr diff` content hashes and note known false-positive classes.

---

## PR 5 — Tiered reviewer with per-tier model/effort settings

**Goal:** follow-up verification runs on a cheap configuration; discovery, escalations,
and the terminal pass on the full configuration. Model and effort per tier are
user-configurable in Settings.

**Config** (`.cortex/config.json`, types in `src/lib/runtime-config.ts` /
`src/app/settings/reviewer-config.ts`):

```jsonc
"reviewer_tiers": {
  "tier1": { "runtime": "codex", "model": "gpt-5.4", "effort": "low" },
  "tier2": { "runtime": "codex", "model": "gpt-5.6-sol", "effort": "high" }
}
```

- Every field optional. `tier2` falls back to the existing defaults
  (`default_agent_runner`, `default_codex_model`/`default_codex_effort` or the claude
  equivalents per runtime). **If `tier1` is absent, tiering is disabled** and all
  rounds run tier 2 — the safe default and the rollout flag.
- Settings page (`src/app/settings/page.tsx`): two runtime/model/effort selector
  groups, "Verification tier (tier 1)" and "Review tier (tier 2)", following the
  existing reviewer-config control patterns; persisted via the config API route.

**Round classification** (in `runReviewPhases` before invoking the runner):
- **Tier 2:** initial review (no stored summary for this diff), escalated rounds,
  and the confirmation pass after tier 1 reports everything verified.
- **Tier 1:** follow-up rounds where a prior summary exists and open findings are
  being verified; reply rounds (PR 4).

**Tier-1 contract** (`src/lib/review-runner.ts`):
- Fresh session (PR 2), seeded with pointers only: stored summary, the
  `last-reviewed → current` SHA pair, and the list of unresolved reviewer-authored
  review threads (IDs/URLs plus first line — the orchestrator fetches this list
  mechanically via `gh api`, identifying reviewer threads by PR 3's receipts or the
  comment prefix; thread bodies, builder replies, diff, and code are pulled by the
  run itself — full read access, small default context).
- Allowed statuses: `fixes_verified` (all open findings resolved at this head),
  `needs_author_changes` (a claim failed — say which findings), `escalate`
  (anything beyond the checklist). Parsing extends the existing `Agent status:`
  line protocol in `review-runner.ts`: any other status, or a tier-1 run that times
  out or aborts (under the existing run timeout), maps to `escalate` — never to the
  error-retry path (`shouldRetryErroredReview`). No tier-specific budget for now;
  add one only if cheap-tier runs are observed re-auditing at length.
- Orchestrator mapping: `fixes_verified` → schedule a tier-2 confirmation round
  (never straight to ready); `escalate` → tier-2 round; `needs_author_changes` →
  existing builder-wake path (~L1785-1804).
- `session_profile` records the tier so the UI can distinguish runs.

**Acceptance criteria:**
- With `tier1` unset, behavior is byte-identical to pre-PR (all tier 2).
- Tier-1 run can never produce `ready_for_human_approval` (unit test the status
  parser and the orchestrator mapping).
- Settings round-trips both tiers' runtime/model/effort.
- `fixes_verified` provably schedules a tier-2 pass at the same diff hash.

---

## Validation

After each PR, measure on live traffic (method: rollout-log analysis as in the
assessment — raw/cached/uncached input per session from `~/.codex/sessions` token
counters, GitHub comment bursts per PR):

- **Rounds per PR** to `ready_for_human_approval` (target: converges at all; then ≤6
  for a healthy PR).
- **Silent review rounds** (runs posting nothing with unchanged diff — target ~0
  after PR 4).
- **Raw input per follow-up round** (target: tier-1 rounds ≤ 1/5 of tier-2 rounds).
- **Re-asked human decisions** (target 0 after PR 1).
- **`needs_human_decision` survival across rebases** (PR 4 acceptance).

Line-number references are approximate (as of `0bc6deb`); locate by symbol name.
