import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveReviewState,
  reviewCoversHeadSha,
  deriveReviewStatus,
  getReviewStateSortGroup,
  withReviewState,
  withReviewStatus,
  type ReviewStateInput,
  type ReviewStatusInput,
} from "./review-status";

const base: ReviewStatusInput = {
  head_sha: "head-sha",
  summary: "Ready summary",
};

const stateBase: ReviewStateInput = {
  head_sha: "head-sha",
  summary: "Ready summary",
};

test("deriveReviewStatus returns every review status", () => {
  assert.equal(
    deriveReviewStatus({ ...base, final_at: "2026-05-01T00:00:00.000Z" }),
    "final"
  );
  assert.equal(
    deriveReviewStatus({ ...base, summary: "", current_run_pid: 123 }),
    "summarizing"
  );
  assert.equal(
    deriveReviewStatus({
      ...base,
      summary_head_sha: "old-head-sha",
    }),
    "needs_review"
  );
  assert.equal(
    deriveReviewStatus({ ...base, error: "failed" }),
    "summary_error"
  );
  assert.equal(deriveReviewStatus({ ...base, summary: "" }), "pending_summary");
  assert.equal(deriveReviewStatus(base), "needs_review");
  assert.equal(
    deriveReviewStatus({ ...base, my_last_review_sha: "old-sha" }),
    "new_commits"
  );
  assert.equal(
    deriveReviewStatus({ ...base, my_last_review_sha: "head-sha" }),
    "up_to_date"
  );
});

test("deriveReviewStatus enforces precedence", () => {
  assert.equal(
    deriveReviewStatus({
      ...base,
      final_at: "2026-05-01T00:00:00.000Z",
      error: "failed",
      current_run_pid: 123,
      my_last_review_sha: "old-sha",
    }),
    "final"
  );
  assert.equal(
    deriveReviewStatus({
      ...base,
      summary: "",
      error: "old failure",
      current_run_pid: 123,
      my_last_review_sha: "old-sha",
    }),
    "summarizing"
  );
  assert.equal(
    deriveReviewStatus({
      ...base,
      error: "failed",
      summary_head_sha: "old-head-sha",
      my_last_review_sha: "head-sha",
    }),
    "summary_error"
  );
  assert.equal(
    deriveReviewStatus({
      ...base,
      summary: "   ",
      my_last_review_sha: "old-sha",
    }),
    "pending_summary"
  );
});

test("deriveReviewState returns every merged review state", () => {
  assert.equal(
    deriveReviewState({ ...stateBase, final_at: "2026-05-01T00:00:00.000Z" }),
    "archived"
  );
  assert.equal(
    deriveReviewState({ ...stateBase, summary: "", current_run_pid: 123 }),
    "generating"
  );
  assert.equal(
    deriveReviewState({ ...stateBase, error: "failed" }),
    "generation_failed"
  );
  assert.equal(deriveReviewState({ ...stateBase, summary: "" }), "queued");
  assert.equal(
    deriveReviewState({ ...stateBase, summary_head_sha: "old-head-sha" }),
    "re_reviewing"
  );
  assert.equal(
    deriveReviewState({ ...stateBase, agent_review_status: "blocked" }),
    "blocked"
  );
  assert.equal(
    deriveReviewState({
      ...stateBase,
      agent_review_status: "needs_author_changes",
    }),
    "needs_author_changes"
  );
  assert.equal(
    deriveReviewState({
      ...stateBase,
      agent_review_status: "needs_human_decision",
    }),
    "needs_decision"
  );
  assert.equal(
    deriveReviewState({
      ...stateBase,
      agent_review_status: "ready_for_human_approval",
    }),
    "ready_to_approve"
  );
  assert.equal(
    deriveReviewState({ ...stateBase, my_approval_sha: "head-sha" }),
    "approved"
  );
  assert.equal(
    deriveReviewState({ ...stateBase, my_changes_requested_sha: "head-sha" }),
    "changes_requested"
  );
  assert.equal(
    deriveReviewState({ ...stateBase, my_last_review_sha: "head-sha" }),
    "reviewed"
  );
  assert.equal(deriveReviewState(stateBase), "needs_review");
  assert.equal(
    deriveReviewState({ ...stateBase, my_last_review_sha: "old-sha" }),
    "needs_review"
  );
});

test("deriveReviewState enforces precedence and verdict-wins", () => {
  // archived beats everything below it.
  assert.equal(
    deriveReviewState({
      ...stateBase,
      final_at: "2026-05-01T00:00:00.000Z",
      current_run_pid: 123,
      error: "failed",
      agent_review_status: "ready_for_human_approval",
    }),
    "archived"
  );
  // generating beats generation_failed / queued / verdict.
  assert.equal(
    deriveReviewState({
      ...stateBase,
      summary: "",
      current_run_pid: 123,
      error: "old failure",
      agent_review_status: "blocked",
    }),
    "generating"
  );
  // generation_failed beats queued / re_reviewing / verdict.
  assert.equal(
    deriveReviewState({
      ...stateBase,
      error: "failed",
      summary_head_sha: "old-head-sha",
      agent_review_status: "needs_author_changes",
    }),
    "generation_failed"
  );
  // queued (no summary) beats any verdict.
  assert.equal(
    deriveReviewState({
      ...stateBase,
      summary: "",
      agent_review_status: "blocked",
    }),
    "queued"
  );
  // re_reviewing (stale summary) beats any verdict.
  assert.equal(
    deriveReviewState({
      ...stateBase,
      summary_head_sha: "old-head-sha",
      agent_review_status: "needs_author_changes",
    }),
    "re_reviewing"
  );
  // re_reviewing (stale summary) beats an approval at HEAD.
  assert.equal(
    deriveReviewState({
      ...stateBase,
      summary_head_sha: "old-head-sha",
      my_approval_sha: "head-sha",
    }),
    "re_reviewing"
  );
  // an approval at the current HEAD beats any agent verdict.
  assert.equal(
    deriveReviewState({
      ...stateBase,
      my_approval_sha: "head-sha",
      agent_review_status: "needs_human_decision",
    }),
    "approved"
  );
  // a stale approval (from before new commits) does not count; verdict wins.
  assert.equal(
    deriveReviewState({
      ...stateBase,
      my_approval_sha: "old-sha",
      agent_review_status: "needs_human_decision",
    }),
    "needs_decision"
  );
  // a change request at the current HEAD beats any agent verdict.
  assert.equal(
    deriveReviewState({
      ...stateBase,
      my_changes_requested_sha: "head-sha",
      agent_review_status: "ready_for_human_approval",
    }),
    "changes_requested"
  );
  // a stale change request (from before new commits) does not count; verdict wins.
  assert.equal(
    deriveReviewState({
      ...stateBase,
      my_changes_requested_sha: "old-sha",
      agent_review_status: "ready_for_human_approval",
    }),
    "ready_to_approve"
  );
  // verdict wins over the "you've reviewed this HEAD" signal.
  assert.equal(
    deriveReviewState({
      ...stateBase,
      my_last_review_sha: "head-sha",
      agent_review_status: "needs_author_changes",
    }),
    "needs_author_changes"
  );
  // no verdict + current summary: reviewed when reviewed at HEAD, else needs_review.
  assert.equal(
    deriveReviewState({ ...stateBase, my_last_review_sha: "head-sha" }),
    "reviewed"
  );
  assert.equal(
    deriveReviewState({ ...stateBase, my_last_review_sha: "old-sha" }),
    "needs_review"
  );
});

test("task-owned reviews use summary freshness and ignore human decision signals", () => {
  assert.equal(
    deriveReviewStatus({
      ...base,
      source: "task",
      summary_head_sha: "head-sha",
    }),
    "up_to_date"
  );
  assert.equal(
    deriveReviewStatus({
      ...base,
      source: "task",
      summary_head_sha: "old-head-sha",
    }),
    "new_commits"
  );
  assert.equal(
    deriveReviewState({
      ...stateBase,
      source: "task",
      my_approval_sha: "head-sha",
      agent_review_status: "needs_author_changes",
    }),
    "needs_author_changes"
  );
  assert.equal(
    deriveReviewState({
      ...stateBase,
      source: "task",
      my_changes_requested_sha: "head-sha",
      agent_review_status: "ready_for_human_approval",
    }),
    "ready_to_approve"
  );
});

test("a rebase that preserved the effective diff is not stale", () => {
  const rebased = {
    ...stateBase,
    source: "task" as const,
    head_sha: "rebased-sha",
    summary_head_sha: "original-sha",
    summary_diff_hash: "diff-1",
    effective_diff_hash: "diff-1",
    effective_diff_head_sha: "rebased-sha",
  };

  assert.equal(deriveReviewStatus(rebased), "up_to_date");
  assert.equal(
    deriveReviewState({
      ...rebased,
      agent_review_status: "needs_human_decision",
    }),
    "needs_decision"
  );
  // The identity has to belong to the current head to mean anything.
  assert.equal(
    deriveReviewStatus({ ...rebased, effective_diff_head_sha: "some-older-sha" }),
    "new_commits"
  );
  // A changed diff is stale again.
  assert.equal(
    deriveReviewStatus({ ...rebased, effective_diff_hash: "diff-2" }),
    "new_commits"
  );
  assert.equal(
    deriveReviewState({ ...rebased, effective_diff_hash: "diff-2" }),
    "re_reviewing"
  );
  // Rows with no stored diff identity keep comparing head SHAs.
  assert.equal(
    deriveReviewStatus({
      ...rebased,
      summary_diff_hash: undefined,
      effective_diff_hash: undefined,
      effective_diff_head_sha: undefined,
    }),
    "new_commits"
  );
});

test("a base move at an unchanged head is a changed diff", () => {
  const covered = {
    ...stateBase,
    source: "task" as const,
    head_sha: "head-1",
    summary_head_sha: "head-1",
    summary_diff_hash: "diff-1",
    effective_diff_hash: "diff-1",
    effective_diff_head_sha: "head-1",
    last_round_diff_hash: "diff-1",
    last_round_head_sha: "head-1",
  };

  // Same head, same identity: covered.
  assert.equal(reviewCoversHeadSha(covered, "head-1", "diff-1"), true);
  // Same head, an identity the round never covered: the base moved under it, so
  // the code under review changed even though no commit was pushed. A known
  // inequality must not be masked by the head watermark.
  assert.equal(reviewCoversHeadSha(covered, "head-1", "diff-2"), false);
  assert.equal(
    reviewCoversHeadSha({ ...covered, summary_diff_hash: undefined }, "head-1", "diff-2"),
    false
  );

  // The head-only shape a verification round leaves when the diff could not be
  // identified converges once an identity appears...
  const headOnly = {
    ...stateBase,
    source: "task" as const,
    head_sha: "head-1",
    summary_head_sha: "head-0",
    summary_diff_hash: undefined,
    last_round_diff_hash: undefined,
    last_round_head_sha: "head-1",
    effective_diff_hash: undefined,
    effective_diff_head_sha: undefined,
  };
  assert.equal(reviewCoversHeadSha(headOnly, "head-1", "diff-2"), true);
  assert.equal(reviewCoversHeadSha(headOnly, "head-1"), true);

  // ...and that convergence does not permanently mask later base moves: once
  // `diff-2` is recorded for this head, `diff-3` at the same head is a change.
  const recovered = {
    ...headOnly,
    effective_diff_hash: "diff-2",
    effective_diff_head_sha: "head-1",
  };
  assert.equal(reviewCoversHeadSha(recovered, "head-1", "diff-2"), true);
  assert.equal(reviewCoversHeadSha(recovered, "head-1", "diff-3"), false);
  // The drift signal is a freshly computed identity disagreeing with the stored
  // one. Deriving state from the row alone cannot see it, because a head-only row
  // records no identity for the round to disagree with — the same blind spot as a
  // base move under an unchanged head, which nothing recomputes for.
  assert.equal(
    deriveReviewState({ ...recovered, effective_diff_hash: "diff-3" }),
    "needs_review"
  );
});

test("withReviewStatus recomputes the legacy status", () => {
  assert.equal(
    withReviewStatus({
      head_sha: "head-sha",
      summary: "Ready summary",
      my_last_review_sha: "old-sha",
      review_status: "up_to_date",
    }).review_status,
    "new_commits"
  );
});

test("withReviewState recomputes the merged state", () => {
  assert.equal(
    withReviewState({
      head_sha: "head-sha",
      summary: "Ready summary",
      my_last_review_sha: "head-sha",
      agent_review_status: "needs_author_changes",
      review_state: "reviewed",
    }).review_state,
    "needs_author_changes"
  );
});

test("getReviewStateSortGroup orders actionable states first and archived last", () => {
  assert.equal(getReviewStateSortGroup("blocked"), 0);
  assert.equal(getReviewStateSortGroup("needs_author_changes"), 0);
  assert.equal(getReviewStateSortGroup("needs_decision"), 0);
  assert.equal(getReviewStateSortGroup("ready_to_approve"), 0);
  assert.equal(getReviewStateSortGroup("needs_review"), 0);
  assert.equal(getReviewStateSortGroup("generating"), 1);
  assert.equal(getReviewStateSortGroup("re_reviewing"), 1);
  assert.equal(getReviewStateSortGroup("generation_failed"), 1);
  assert.equal(getReviewStateSortGroup("queued"), 1);
  assert.equal(getReviewStateSortGroup("reviewed"), 2);
  assert.equal(getReviewStateSortGroup("archived"), 3);
});
