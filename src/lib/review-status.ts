import type { ReviewStatus } from "./types";

export interface ReviewStatusInput {
  summary?: string;
  summary_head_sha?: string;
  error?: string;
  current_run_pid?: number;
  final_at?: string;
  my_last_review_sha?: string;
  head_sha: string;
}

const REVIEW_STATUS_SORT_GROUP: Record<ReviewStatus, number> = {
  needs_review: 0,
  new_commits: 0,
  pending_summary: 1,
  summarizing: 1,
  summary_error: 1,
  up_to_date: 1,
  final: 2,
};

export function deriveReviewStatus(review: ReviewStatusInput): ReviewStatus {
  const hasSummary = Boolean(review.summary?.trim());

  if (review.final_at) return "final";
  if (review.current_run_pid != null) return "summarizing";
  if (review.error) return "summary_error";
  if (!hasSummary) return "pending_summary";
  if (!review.my_last_review_sha) return "needs_review";
  if (review.my_last_review_sha !== review.head_sha) return "new_commits";
  return "up_to_date";
}

export function withReviewStatus<T extends ReviewStatusInput>(
  review: T
): T & { review_status: ReviewStatus } {
  return {
    ...review,
    review_status: deriveReviewStatus(review),
  };
}

export function getReviewStatusSortGroup(status: ReviewStatus): number {
  return REVIEW_STATUS_SORT_GROUP[status];
}
