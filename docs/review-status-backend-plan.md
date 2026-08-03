# Review Status Backend Plan

## Goal

Move Reviews to the same model as Tasks: backend-owned state, frontend-owned presentation only.

The Reviews table and detail page should no longer derive review state from `my_last_review_sha`, `head_sha`, `summary`, `current_run_pid`, or `final_at` in React. Backend code should emit a single typed status for each review, and the frontend should map that status to labels, colors, sorting, and counts.

Also update review submission UX: after a successful Approve, Request changes, or Comment action, navigate back to `/reviews`.

## Status Model

Add a backend-owned status field:

```ts
export type ReviewStatus =
  | "needs_review"
  | "new_commits"
  | "up_to_date"
  | "pending_summary"
  | "summarizing"
  | "summary_error"
  | "final";
```

Add `review_status: ReviewStatus` to `ReviewSummary`.

Use this precedence when deriving status:

1. `final`: `final_at` is set.
2. `summarizing`: no `summary` and `current_run_pid` is set.
3. `summary_error`: `error` is set.
4. `pending_summary`: no `summary` yet, no active run, no error.
5. `needs_review`: no `my_last_review_sha`.
6. `new_commits`: `my_last_review_sha !== head_sha`.
7. `up_to_date`: `my_last_review_sha === head_sha`.

This means a review with no summary is not treated as ready/actionable yet, even if the underlying PR is awaiting review. It should look like a new task that has not been picked up.

## Backend Implementation

Create a new helper module:

```text
src/lib/review-status.ts
```

Suggested exports:

```ts
export function deriveReviewStatus(review: ReviewStatusInput): ReviewStatus;
export function withReviewStatus<T extends ReviewStatusInput>(review: T): T & { review_status: ReviewStatus };
export function getReviewStatusSortGroup(status: ReviewStatus): number;
```

`ReviewStatusInput` can be a local type requiring only:

- `summary?: string`
- `error?: string`
- `current_run_pid?: number`
- `final_at?: string`
- `my_last_review_sha?: string`
- `head_sha: string`

Update `src/lib/review-store.ts` so review records are normalized on both read and write:

- `readReviewSummaries()` returns records with `review_status`.
- `readReviewSummaryMap()` returns records with `review_status`.
- `upsertReviewSummary()` writes a normalized record.
- `patchReviewSummary()` merges, recomputes status, then writes.

This gives old `.cortex/reviews.json` files a safe migration path while keeping new writes consistent.

Update any direct `ReviewSummary` construction in tests and backend code as needed. Prefer passing through the store normalization instead of hand-maintaining `review_status` at every call site.

## API Sorting

Move Reviews table sorting into `GET /api/reviews` in:

```text
src/app/api/reviews/route.ts
```

Sort by group first, then `updated_at` descending within each group.

Groups:

```ts
const REVIEW_STATUS_SORT_GROUP: Record<ReviewStatus, number> = {
  needs_review: 0,
  new_commits: 0,
  pending_summary: 1,
  summarizing: 1,
  summary_error: 1,
  up_to_date: 1,
  final: 2,
};
```

Do not filter out final reviews in the API or frontend. Reviews with `final_at` should remain visible during the existing 24 hour GC window, sorted at the bottom.

## Frontend Presentation

Update these files:

```text
src/app/reviews/page.tsx
src/app/reviews/[id]/page.tsx
src/components/reviews-nav-link.tsx
```

Remove frontend state derivation helpers such as:

- `rowState(review)`
- SHA comparisons in React components
- frontend filtering by `final_at`

The frontend should only inspect `review.review_status`.

### Labels

Use these labels:

| Status | Label |
| --- | --- |
| `needs_review` | Awaiting your review |
| `new_commits` | New commits since your review |
| `up_to_date` | Up to date with your review |
| `pending_summary` | No summary yet |
| `summarizing` | Summary being generated |
| `summary_error` | Summary error |
| `final` | No longer live |

### Row Colors

Match Tasks behavior:

| Status | Row behavior |
| --- | --- |
| `needs_review` | `bg-yellow-500/10`, same as task `needs_approval` |
| `new_commits` | `bg-yellow-500/10`, same as task `needs_approval` |
| `up_to_date` | `bg-green-500/10`, same as ready-to-merge tasks |
| `pending_summary` | default row, same as a new task not picked up yet |
| `summarizing` | `animate-pulse-green`, same as an agent working on a task |
| `summary_error` | `bg-red-500/10`, same family as failing task states |
| `final` | `bg-muted/40 opacity-60`, same as closed tasks |

### Badge Colors

Use badge colors aligned with row meaning:

| Status | Badge behavior |
| --- | --- |
| `needs_review` | `bg-yellow-100 text-yellow-800` |
| `new_commits` | `bg-yellow-100 text-yellow-800` |
| `up_to_date` | `bg-green-100 text-green-800` |
| `pending_summary` | `bg-blue-100 text-blue-800` |
| `summarizing` | `bg-green-100 text-green-800` |
| `summary_error` | `bg-red-100 text-red-800` |
| `final` | `bg-gray-100 text-gray-800` |

The detail page summary body can keep its existing content states:

- `summarizing`: muted italic `Summarizing...`
- `summary_error`: destructive text with the error
- `pending_summary`: muted italic `No summary yet.`

But the badge and high-level status should come from `review_status`.

## Nav Count

Update `countReadyActionableReviews()` to count only:

- `review_status === "needs_review"`
- `review_status === "new_commits"`

Do not count:

- `pending_summary`
- `summarizing`
- `summary_error`
- `up_to_date`
- `final`

This keeps the sidebar count limited to ready review work that needs attention.

## Submit Navigation

In `src/app/reviews/[id]/page.tsx`, after a successful `POST /api/reviews/submit`:

1. Clear the submit dialog state.
2. Refresh review data if needed.
3. Navigate to `/reviews`.

Use `useRouter` from `next/navigation`:

```ts
const router = useRouter();
```

Then after success:

```ts
setSubmitState(null);
await mutate();
router.push("/reviews");
```

This should apply to all three review submission decisions: approve, request changes, and comment.

## Tests

Add or update tests in these areas:

```text
src/lib/review-status.test.ts
src/lib/review-store.test.ts
src/app/api/routes.test.ts
src/components/reviews-nav-link.test.tsx
src/app/pages.test.tsx
```

Required coverage:

1. `deriveReviewStatus()` returns every status.
2. Status precedence is enforced:
   - `final` wins over all.
   - `summarizing` wins over old errors while a run is active and no summary exists.
   - `summary_error` wins over attention/up-to-date states.
   - `pending_summary` wins over attention/up-to-date states when summary is empty.
3. `readReviewSummaries()` and `readReviewSummaryMap()` backfill `review_status` for old cached records.
4. `upsertReviewSummary()` and `patchReviewSummary()` write normalized `review_status`.
5. `/api/reviews` returns final reviews and sorts:
   - `needs_review` and `new_commits` first.
   - everything except final next.
   - `final` last.
   - `updated_at` descending within each group.
6. Reviews page maps each `review_status` to the expected row class and badge label/color.
7. Reviews page no longer filters `final_at` records out.
8. Sidebar count includes only `needs_review` and `new_commits`.
9. Detail page submit success navigates to `/reviews`.

Also update existing fixtures that still use the old stray `review_state` field. Replace it with `review_status` where relevant, or remove it if it is not used.

## Acceptance Checks

Run:

```sh
npm test
npm run lint
```

Use grep checks to confirm state derivation moved out of React:

```sh
rg "my_last_review_sha|head_sha|final_at" src/app/reviews src/components/reviews-nav-link.tsx
```

Expected result: React may display data or pass URLs, but should not compare `my_last_review_sha` to `head_sha`, filter on `final_at`, or derive review state. State decisions should come from backend helpers and `review_status`.

Manual behavior to verify:

1. Reviews needing attention are yellow and sorted first.
2. Up-to-date reviews are green.
3. Summary errors are red.
4. No-summary reviews have default rows.
5. Final reviews are visible, muted, and sorted last during the 24 hour GC window.
6. Active summary generation flashes green.
7. Approve, Request changes, and Comment return to `/reviews` after success.
