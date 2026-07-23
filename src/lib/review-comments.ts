import { createHash } from "crypto";
import type { ReviewerCommentCancellation } from "./types";

export const REVIEWER_GITHUB_COMMENT_PREFIX =
  "**🤖[Cortex City Reviewer]**";

export const REVIEWER_HUMAN_DECISION_COMMENT_PREFIX =
  `${REVIEWER_GITHUB_COMMENT_PREFIX} **Human decision needed:**`;

export const REVIEWER_SELF_APPROVAL_COMMENT_PREFIX =
  `${REVIEWER_GITHUB_COMMENT_PREFIX} **Ready for manual approval:**`;

const REVIEWER_HUMAN_DECISION_COMMENT_TOKEN_PREFIX =
  "<!-- cortex-city-review-decision:";

export function reviewerHumanDecisionCommentMarker(token: string): string {
  return `${REVIEWER_HUMAN_DECISION_COMMENT_TOKEN_PREFIX}${token} -->`;
}

export function buildReviewerCommentBody(
  prefix:
    | typeof REVIEWER_HUMAN_DECISION_COMMENT_PREFIX
    | typeof REVIEWER_SELF_APPROVAL_COMMENT_PREFIX,
  message: string,
  actionToken: string
): string {
  return `${prefix} ${message.trim()}\n\n${reviewerHumanDecisionCommentMarker(actionToken)}`;
}

export function reviewerCommentBodySha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function appendReviewerCommentCancellation(
  existing: ReviewerCommentCancellation[] | undefined,
  cancellation: ReviewerCommentCancellation
): ReviewerCommentCancellation[] {
  return [
    ...(existing || []).filter(
      (candidate) => candidate.action_token !== cancellation.action_token
    ),
    cancellation,
  ];
}
