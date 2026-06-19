import type { ReviewAgentStatus, ReviewStatus } from "./types";

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  needs_review: "Awaiting your review",
  new_commits: "New commits since your review",
  up_to_date: "Up to date with your review",
  pending_summary: "No summary yet",
  summarizing: "Summary being generated",
  summary_error: "Summary error",
  final: "No longer live",
};

export const REVIEW_STATUS_ROW_CLASSES: Record<ReviewStatus, string> = {
  needs_review: "bg-yellow-500/10",
  new_commits: "bg-yellow-500/10",
  up_to_date: "bg-green-500/10",
  pending_summary: "",
  summarizing: "animate-pulse-green",
  summary_error: "bg-red-500/10",
  final: "bg-muted/40 opacity-60",
};

export const REVIEW_STATUS_BADGE_CLASSES: Record<ReviewStatus, string> = {
  needs_review: "bg-yellow-100 text-yellow-800",
  new_commits: "bg-yellow-100 text-yellow-800",
  up_to_date: "bg-green-100 text-green-800",
  pending_summary: "bg-blue-100 text-blue-800",
  summarizing: "bg-green-100 text-green-800",
  summary_error: "bg-red-100 text-red-800",
  final: "bg-gray-100 text-gray-800",
};

export const REVIEW_AGENT_STATUS_LABELS: Record<ReviewAgentStatus, string> = {
  ready_for_human_approval: "Agent ready",
  needs_author_changes: "Agent needs changes",
  needs_human_decision: "Agent needs decision",
  blocked: "Agent blocked",
};

export const REVIEW_AGENT_STATUS_BADGE_CLASSES: Record<ReviewAgentStatus, string> = {
  ready_for_human_approval: "bg-green-100 text-green-800",
  needs_author_changes: "bg-yellow-100 text-yellow-800",
  needs_human_decision: "bg-blue-100 text-blue-800",
  blocked: "bg-red-100 text-red-800",
};

export function getReviewStatusLabel(status: ReviewStatus): string {
  return REVIEW_STATUS_LABELS[status];
}

export function getReviewStatusRowClass(status: ReviewStatus): string {
  return REVIEW_STATUS_ROW_CLASSES[status];
}

export function getReviewStatusBadgeClass(status: ReviewStatus): string {
  return REVIEW_STATUS_BADGE_CLASSES[status];
}

export function getReviewAgentStatusLabel(status: ReviewAgentStatus): string {
  return REVIEW_AGENT_STATUS_LABELS[status];
}

export function getReviewAgentStatusBadgeClass(
  status: ReviewAgentStatus
): string {
  return REVIEW_AGENT_STATUS_BADGE_CLASSES[status];
}
