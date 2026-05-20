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
    ...overrides,
  };
}

test("countReadyActionableReviews only counts actionable reviews with summaries", () => {
  assert.equal(
    countReadyActionableReviews([
      review({ pr_url: "https://github.com/acme/widget/pull/1" }),
      review({
        pr_url: "https://github.com/acme/widget/pull/2",
        summary: "",
        current_run_pid: 123,
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/3",
        summary: "Previous summary",
        current_run_pid: 456,
        my_last_review_sha: "old-sha",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/4",
        my_last_review_sha: "head-sha",
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/5",
        final_at: now,
      }),
      review({
        pr_url: "https://github.com/acme/widget/pull/6",
        summary: "   ",
      }),
    ]),
    2
  );
});

test("countReadyActionableReviews is undefined while reviews are loading", () => {
  assert.equal(countReadyActionableReviews(undefined), undefined);
});
