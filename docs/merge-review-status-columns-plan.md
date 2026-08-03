# Merge Review Status Columns Plan

## Goal

The `/reviews` table currently has **two** status columns:

- **"Status"** → `review.review_status` (`ReviewStatus`, backend-derived) — `src/app/reviews/page.tsx:53,77-83`
- **"Agent"** → `review.agent_review_status` (`ReviewAgentStatus`, parsed from the agent's output) — `src/app/reviews/page.tsx:54,84-94`

Merge them into a **single status column** driven by one backend-derived field. This continues the
"backend-owned state, frontend-owned presentation only" model already established in
`docs/review-status-backend-plan.md`.

The resolution rule is **verdict wins**: when the agent has produced a current verdict, show it; otherwise
fall back to the pipeline/freshness state.

## Why this merge is safe (findings)

These two columns look independent but are two slices of one state machine. The investigation that justifies
collapsing them:

1. **The agent verdict is always current when present.**
   It is cleared to `undefined` whenever HEAD moves (`src/lib/orchestrator-worker-runtime.ts:587`) and is only
   ever repopulated by a fresh run against the current head
   (`src/lib/review-runner.ts:507`, `:520-521` via `parseReviewAgentStatus`). So a "stale verdict" cannot be
   displayed, and impossible combinations like `new_commits` + `ready_for_human_approval` never occur.

2. **The human-freshness axis is unreliable, so it must not override the verdict.**
   `review_status`'s `needs_review` / `new_commits` / `up_to_date` distinction is keyed off
   `my_last_review_sha`, which is computed by `getMyLastReviewSha` (`src/lib/github.ts:392-409`). That match is
   **identity-only and signature-blind** — it matches any non-`PENDING` review by the authenticated account and
   does **not** inspect the body. Because the reviewer agent posts `COMMENTED` reviews under the same account
   (`src/lib/prompt-builder.ts:137-141`), the agent's own activity can flip a PR to `up_to_date` even though the
   human never looked. Therefore "you've reviewed" is the least trustworthy input and should not beat a real
   agent verdict.

3. **Decision: verdict wins.** Confirmed with the team.

## Merged Status Model

Add a single backend-owned, derived field `review_state: ReviewState` to `ReviewSummary`. Keep the existing
`review_status` and `agent_review_status` as the underlying inputs (still used to compute `review_state` and
potentially for analytics); the frontend reads only `review_state`.

```ts
export type ReviewState =
  | "archived"              // final_at set
  | "generating"            // a review run is in progress (current_run_pid set)
  | "generation_failed"     // error set
  | "queued"                // no summary yet, no active run, no error
  | "re_reviewing"          // summary stale vs HEAD (new commits; verdict already cleared)
  | "blocked"               // verdict: agent could not complete the review
  | "needs_author_changes"  // verdict: agent found required changes
  | "needs_decision"        // verdict: agent flagged advisory/uncertain points for you
  | "ready_to_approve"      // verdict: agent found nothing blocking
  | "reviewed"              // no verdict, summary current, you've reviewed this HEAD
  | "needs_review";         // no verdict, summary current, you haven't reviewed (fallback)
```

### Derivation precedence (top wins)

```text
1. archived            : final_at is set
2. generating          : current_run_pid is set
3. generation_failed   : error is set
4. queued              : no summary yet
5. re_reviewing        : summary_head_sha is set and !== head_sha   (new commits; verdict cleared)
6. <verdict present>   : map agent_review_status ->
                           blocked                  -> blocked
                           needs_author_changes     -> needs_author_changes
                           needs_human_decision     -> needs_decision
                           ready_for_human_approval -> ready_to_approve
7. <no verdict, summary current>:
                           my_last_review_sha === head_sha -> reviewed
                           else                            -> needs_review
```

Notes:
- Steps 1-4 mirror the existing `deriveReviewStatus` precedence (`src/lib/review-status.ts:30-40`), so a review
  with no usable summary is never shown as actionable.
- Step 5 uses the summary-vs-HEAD staleness check that already exists for the detail page
  (`src/app/reviews/[id]/page.tsx:89`) and the worker (`summaryHeadShaFor` in
  `src/lib/orchestrator-worker-runtime.ts:616`).
- "verdict wins": steps 6 beats step 7. The `up_to_date` signal only surfaces (as `reviewed`) when there is no
  current verdict — the rare parse-miss / legacy-data case.

### Mapping from old columns

| Old `review_status` | Old `agent_review_status` | New `review_state` |
| --- | --- | --- |
| `final` | (any) | `archived` |
| `summarizing` | (any) | `generating` |
| `summary_error` | (any) | `generation_failed` |
| `pending_summary` | (any) | `queued` |
| `new_commits` | (always cleared to none) | `re_reviewing` |
| `needs_review` / `up_to_date` | `blocked` | `blocked` |
| `needs_review` / `up_to_date` | `needs_author_changes` | `needs_author_changes` |
| `needs_review` / `up_to_date` | `needs_human_decision` | `needs_decision` |
| `needs_review` / `up_to_date` | `ready_for_human_approval` | `ready_to_approve` |
| `up_to_date` | none | `reviewed` |
| `needs_review` | none | `needs_review` |

Nothing actionable is lost: the only old combination without a 1:1 home is "you reviewed this HEAD **and**
there is an open verdict" (e.g. `up_to_date` + `needs_author_changes`). Per the verdict-wins decision and
finding #2, the verdict is shown and the (unreliable) "reviewed" fact is dropped for that row.

## Backend Implementation

Add to `src/lib/review-status.ts`:

```ts
export function deriveReviewState(review: ReviewStateInput): ReviewState;
export function withReviewState<T extends ReviewStateInput>(review: T): T & { review_state: ReviewState };
export function getReviewStateSortGroup(state: ReviewState): number;
```

- `ReviewStateInput` extends the existing `ReviewStatusInput` with `agent_review_status?: ReviewAgentStatus`.
  It already has `summary`, `error`, `current_run_pid`, `final_at`, `my_last_review_sha`, `head_sha`, plus
  `summary_head_sha` for the staleness check.
- Implement `deriveReviewState` from the precedence above. It can reuse `deriveReviewStatus` internally or
  share helpers; keep both functions until the migration is verified, then `review_status` can become an
  internal detail.
- Fold `review_state` into the store normalization in `src/lib/review-store.ts` alongside the existing
  `withReviewStatus` calls (read/write/upsert/patch), so old `.cortex/reviews.json` records backfill safely.

### Sort groups

Replace the two existing sort-group maps (`REVIEW_STATUS_SORT_GROUP` and `REVIEW_AGENT_STATUS_SORT_GROUP` in
`src/lib/review-status.ts:13-28`) with one ordering over `ReviewState`. Suggested attention order (lower =
higher in the list):

```ts
const REVIEW_STATE_SORT_GROUP: Record<ReviewState, number> = {
  blocked: 0,
  needs_author_changes: 0,
  needs_decision: 0,
  ready_to_approve: 0,
  needs_review: 0,
  generating: 1,
  re_reviewing: 1,
  generation_failed: 1,
  queued: 1,
  reviewed: 2,
  archived: 3,
};
```

Sorting stays in `GET /api/reviews` (`src/app/api/reviews/route.ts`): group ascending, then `updated_at`
descending within a group. Final/archived reviews remain visible (not filtered) during the existing 24h GC
window.

## Frontend Presentation

### Presentation maps — `src/lib/review-status-presentation.ts`

Replace the two label/row/badge map sets and the `getReviewAgentStatus*` helpers with a single set keyed by
`ReviewState`:

| `review_state` | Label | Row class | Badge class |
| --- | --- | --- | --- |
| `blocked` | Blocked | `bg-red-500/10` | `bg-red-100 text-red-800` |
| `needs_author_changes` | Needs author changes | `bg-yellow-500/10` | `bg-yellow-100 text-yellow-800` |
| `needs_decision` | Needs your decision | `bg-yellow-500/10` | `bg-blue-100 text-blue-800` |
| `ready_to_approve` | Ready to approve | `bg-green-500/10` | `bg-green-100 text-green-800` |
| `needs_review` | Awaiting your review | `bg-yellow-500/10` | `bg-yellow-100 text-yellow-800` |
| `generating` | Generating… | `animate-pulse-green` | `bg-green-100 text-green-800` |
| `re_reviewing` | Re-reviewing (new commits) | `animate-pulse-green` | `bg-blue-100 text-blue-800` |
| `generation_failed` | Summary error | `bg-red-500/10` | `bg-red-100 text-red-800` |
| `queued` | No summary yet | `` (default) | `bg-blue-100 text-blue-800` |
| `reviewed` | Up to date with your review | `bg-green-500/10` | `bg-green-100 text-green-800` |
| `archived` | No longer live | `bg-muted/40 opacity-60` | `bg-gray-100 text-gray-800` |

(Colors reuse the existing palette so nothing visually regresses.)

### Table — `src/app/reviews/page.tsx`

- Remove the `<TableHead>Agent</TableHead>` column header (`:54`) and its `<TableCell>` (`:84-94`).
- Drive the single "Status" cell (`:77-83`) and the row class (`:62`) from `review.review_state` using the new
  presentation helpers. The `—` em-dash fallback for a missing agent status (`:92`) goes away.

### Detail page — `src/app/reviews/[id]/page.tsx`

- Show one merged status badge from `review_state` instead of separate review/agent badges. Keep the existing
  summary-body content states (summarizing / error / no-summary) as-is.

### Nav count — `src/components/reviews-nav-link.tsx`

Update `countReadyActionableReviews()` to count the actionable merged states only:

- `blocked`, `needs_author_changes`, `needs_decision`, `ready_to_approve`, `needs_review`

Do **not** count `generating`, `re_reviewing`, `generation_failed`, `queued`, `reviewed`, `archived`.

## Tests

Add / update:

```text
src/lib/review-status.test.ts
src/lib/review-store.test.ts
src/app/api/routes.test.ts
src/components/reviews-nav-link.test.tsx
src/app/pages.test.tsx
```

Required coverage:

1. `deriveReviewState()` returns every state.
2. Precedence:
   - `archived` > `generating` > `generation_failed` > `queued` > `re_reviewing` > verdict states.
   - **verdict wins over `up_to_date`**: `up_to_date` input + `needs_author_changes` verdict → `needs_author_changes` (not `reviewed`).
   - no verdict + summary current → `reviewed` when `my_last_review_sha === head_sha`, else `needs_review`.
3. Store read/upsert/patch backfill `review_state` for legacy records.
4. `/api/reviews` sorts by the new group map; archived still returned, sorted last.
5. Reviews page renders a single status column (no "Agent" header) and maps each `review_state` to the right
   label/row/badge.
6. Sidebar count includes only the five actionable states above.

## Acceptance Checks

```sh
npm test
npm run lint
```

Confirm the frontend reads only the merged field and does no state derivation:

```sh
rg "agent_review_status|my_last_review_sha|head_sha|final_at" src/app/reviews src/components/reviews-nav-link.tsx
```

Expected: React displays `review_state` and may pass URLs, but does not compare SHAs, inspect
`agent_review_status`, or derive state.

Manual checks:

1. A PR with an open agent verdict shows that verdict, even if it reads as `up_to_date` underneath.
2. New commits flip the row to "Re-reviewing", then "Generating…", then the fresh verdict — with no action from you.
3. Errors are red; queued/no-summary rows are default; archived rows are muted and sorted last.

## Out of Scope / Follow-ups

These came up during investigation and are **not** part of the column merge:

- **A. Trustworthy human-review signal.** `getMyLastReviewSha` (`src/lib/github.ts:392`) should exclude
  reviews whose body starts with the `🤖[Cortex City Reviewer]` signature (`src/lib/prompt-builder.ts:8`), so
  `reviewed` / `needs_review` reflect the human and not the agent's own `COMMENTED` reviews. Independent of the
  merge; the merge works either way.

- **B. Follow-up box does not move status (by design).** The UI follow-up box calls `askFollowup`
  (`src/lib/review-runner.ts:546-642`) → `appendFollowup`, which only appends to `followups[]` and never touches
  `agent_review_status` or `review_status`. So telling the agent to leave comments via the box leaves the
  status unchanged. If we want follow-up-driven comments to update the verdict, `askFollowup` would need to
  optionally re-parse/set `agent_review_status` — a deliberate addition to decide separately.
