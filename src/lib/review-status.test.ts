import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveReviewState,
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
