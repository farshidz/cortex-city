import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewSummary } from "@/lib/types";
import { countReadyActionableReviews } from "./reviews-nav-link";

const now = "2026-05-20T00:00:00.000Z";

function review(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    pr_url: "https://github.com/acme/widget/pull/1",
    pr_number: 1,
    repo_slug: "acme/widget",
    title: "Add review flow",
    author: "octocat",
    head_sha: "head-sha",
    created_at: now,
    updated_at: now,
    summary: "Ready summary",
    generated_at: now,
    review_status: "needs_review",
    review_state: "needs_review",
    ...overrides,
  };
}

test("countReadyActionableReviews only counts actionable merged states", () => {
  assert.equal(
    countReadyActionableReviews([
      review({
        pr_url: "https://github.com/acme/widget/pull/1",
        review_state: "blocked",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/2",
        review_state: "needs_author_changes",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/3",
        review_state: "needs_decision",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/4",
        review_state: "ready_to_approve",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/5",
        review_state: "needs_review",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/6",
        review_state: "generating",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/7",
        review_state: "re_reviewing",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/8",
        review_state: "generation_failed",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/9",
        review_state: "queued",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/10",
        review_state: "reviewed",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/11",
        review_state: "archived",
      }),
    ]),
    5
  );
});

test("countReadyActionableReviews is undefined while reviews are loading", () => {
  assert.equal(countReadyActionableReviews(undefined), undefined);
});

test("countReadyActionableReviews excludes task-owned review records", () => {
  assert.equal(
    countReadyActionableReviews([
      review({
        pr_url: "https://github.com/acme/widget/pull/1",
        source: "inbound",
        review_state: "needs_review",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/2",
        review_state: "ready_to_approve",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/3",
        source: "task",
        task_id: "task-1",
        review_state: "blocked",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/4",
        source: "task",
        task_id: "task-2",
        review_state: "needs_author_changes",
      }),
    ]),
    2
  );
});
