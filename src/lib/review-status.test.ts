import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveReviewStatus,
  getReviewStatusSortGroup,
  withReviewStatus,
  type ReviewStatusInput,
} from "./review-status";

const base: ReviewStatusInput = {
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

test("withReviewStatus recomputes status and sort groups match API order", () => {
  assert.deepEqual(
    withReviewStatus({
      head_sha: "head-sha",
      summary: "Ready summary",
      my_last_review_sha: "old-sha",
      review_status: "up_to_date",
    }).review_status,
    "new_commits"
  );

  assert.equal(getReviewStatusSortGroup("needs_review"), 0);
  assert.equal(getReviewStatusSortGroup("new_commits"), 0);
  assert.equal(getReviewStatusSortGroup("pending_summary"), 1);
  assert.equal(getReviewStatusSortGroup("summarizing"), 1);
  assert.equal(getReviewStatusSortGroup("summary_error"), 1);
  assert.equal(getReviewStatusSortGroup("up_to_date"), 1);
  assert.equal(getReviewStatusSortGroup("final"), 2);
});
