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
    ...overrides,
  };
}

test("countReadyActionableReviews only counts ready review work", () => {
  assert.equal(
    countReadyActionableReviews([
      review({
        pr_url: "https://github.com/acme/widget/pull/1",
        review_status: "needs_review",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/2",
        review_status: "new_commits",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/3",
        review_status: "pending_summary",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/4",
        review_status: "summarizing",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/5",
        review_status: "summary_error",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/6",
        review_status: "up_to_date",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/7",
        review_status: "final",
      }),
    ]),
    2
  );
});

test("countReadyActionableReviews is undefined while reviews are loading", () => {
  assert.equal(countReadyActionableReviews(undefined), undefined);
});
