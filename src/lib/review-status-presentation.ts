import type { ReviewState } from "./types";

export const REVIEW_STATE_LABELS: Record<ReviewState, string> = {
  blocked: "Blocked",
  needs_author_changes: "Needs author changes",
  needs_decision: "Needs your decision",
  ready_to_approve: "Ready to approve",
  needs_review: "Awaiting your review",
  generating: "Generating…",
  re_reviewing: "Re-reviewing (new commits)",
  generation_failed: "Summary error",
  queued: "No summary yet",
  approved: "Approved",
  reviewed: "Up to date with your review",
  archived: "No longer live",
};

export const REVIEW_STATE_ROW_CLASSES: Record<ReviewState, string> = {
  blocked: "bg-red-500/10",
  needs_author_changes: "bg-yellow-500/10",
  needs_decision: "bg-yellow-500/10",
  ready_to_approve: "bg-green-500/10",
  needs_review: "bg-yellow-500/10",
  generating: "animate-pulse-green",
  re_reviewing: "animate-pulse-green",
  generation_failed: "bg-red-500/10",
  queued: "",
  approved: "bg-green-500/10",
  reviewed: "bg-green-500/10",
  archived: "bg-muted/40 opacity-60",
};

export const REVIEW_STATE_BADGE_CLASSES: Record<ReviewState, string> = {
  blocked: "bg-red-100 text-red-800",
  needs_author_changes: "bg-yellow-100 text-yellow-800",
  needs_decision: "bg-blue-100 text-blue-800",
  ready_to_approve: "bg-green-100 text-green-800",
  needs_review: "bg-yellow-100 text-yellow-800",
  generating: "bg-green-100 text-green-800",
  re_reviewing: "bg-blue-100 text-blue-800",
  generation_failed: "bg-red-100 text-red-800",
  queued: "bg-blue-100 text-blue-800",
  approved: "bg-green-100 text-green-800",
  reviewed: "bg-green-100 text-green-800",
  archived: "bg-gray-100 text-gray-800",
};

export function getReviewStateLabel(state: ReviewState): string {
  return REVIEW_STATE_LABELS[state];
}

export function getReviewStateRowClass(state: ReviewState): string {
  return REVIEW_STATE_ROW_CLASSES[state];
}

export function getReviewStateBadgeClass(state: ReviewState): string {
  return REVIEW_STATE_BADGE_CLASSES[state];
}
