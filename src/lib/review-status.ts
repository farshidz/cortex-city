import type { ReviewAgentStatus, ReviewState, ReviewStatus } from "./types";

export interface ReviewStatusInput {
  summary?: string;
  summary_head_sha?: string;
  error?: string;
  current_run_pid?: number;
  final_at?: string;
  my_last_review_sha?: string;
  head_sha: string;
}

export interface ReviewStateInput extends ReviewStatusInput {
  agent_review_status?: ReviewAgentStatus;
}

// Attention ordering for the merged state (lower sorts higher in the list).
// 0: actionable for you, 1: in-flight / no usable summary, 2: handled, 3: archived.
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

const AGENT_STATUS_TO_STATE: Record<ReviewAgentStatus, ReviewState> = {
  blocked: "blocked",
  needs_author_changes: "needs_author_changes",
  needs_human_decision: "needs_decision",
  ready_for_human_approval: "ready_to_approve",
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

// Merge the pipeline/freshness axis and the agent verdict axis into one state.
// Precedence (top wins): archived > generating > generation_failed > queued >
// re_reviewing > verdict > reviewed/needs_review. "Verdict wins" means a current
// agent verdict beats the (signature-blind, unreliable) "you've reviewed" signal,
// which only ever surfaces as `reviewed` when no verdict is present.
export function deriveReviewState(review: ReviewStateInput): ReviewState {
  const hasSummary = Boolean(review.summary?.trim());

  if (review.final_at) return "archived";
  if (review.current_run_pid != null) return "generating";
  if (review.error) return "generation_failed";
  if (!hasSummary) return "queued";

  // Summary present: a stale summary means HEAD moved (verdict already cleared).
  const summaryHeadSha = review.summary_head_sha || review.head_sha;
  if (summaryHeadSha !== review.head_sha) return "re_reviewing";

  if (review.agent_review_status) {
    return AGENT_STATUS_TO_STATE[review.agent_review_status];
  }

  if (review.my_last_review_sha === review.head_sha) return "reviewed";
  return "needs_review";
}

export function withReviewStatus<T extends ReviewStatusInput>(
  review: T
): T & { review_status: ReviewStatus } {
  return {
    ...review,
    review_status: deriveReviewStatus(review),
  };
}

export function withReviewState<T extends ReviewStateInput>(
  review: T
): T & { review_state: ReviewState } {
  return {
    ...review,
    review_state: deriveReviewState(review),
  };
}

export function getReviewStateSortGroup(state: ReviewState): number {
  return REVIEW_STATE_SORT_GROUP[state];
}
