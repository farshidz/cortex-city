import { createHash } from "crypto";
import type {
  ReviewerCommentCancellation,
  ReviewerCommentReceipt,
  ReviewerCommentSurface,
} from "./types";

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

// The reviewer is instructed to open every comment it posts with this prefix.
// A prefix match alone proves nothing (anyone can copy it), so callers must
// also require the comment's author to be the signed-in user.
export function isReviewerAuthoredCommentBody(body?: string | null): boolean {
  return (body || "").trimStart().startsWith(REVIEWER_GITHUB_COMMENT_PREFIX);
}

export function reviewerCommentSurfaceOf(
  receipt: Pick<ReviewerCommentReceipt, "surface">
): ReviewerCommentSurface {
  return receipt.surface === "review_comment" ? "review_comment" : "issue";
}

function reviewerCommentReceiptKey(
  receipt: Pick<ReviewerCommentReceipt, "comment_id" | "surface">
): string {
  return `${reviewerCommentSurfaceOf(receipt)}:${receipt.comment_id}`;
}

// Receipts are a set keyed by (surface, comment id); the delivery action token,
// when present, is a second unique key. A re-observed comment replaces its
// earlier receipt so a rebuilt body hash cannot be stored twice.
export function appendReviewerCommentReceipts(
  existing: ReviewerCommentReceipt[] | undefined,
  added: ReviewerCommentReceipt[]
): ReviewerCommentReceipt[] {
  if (added.length === 0) return existing || [];
  const addedKeys = new Set(added.map(reviewerCommentReceiptKey));
  const addedTokens = new Set(
    added.map((receipt) => receipt.action_token).filter(Boolean)
  );
  return [
    ...(existing || []).filter(
      (candidate) =>
        !addedKeys.has(reviewerCommentReceiptKey(candidate)) &&
        !(candidate.action_token && addedTokens.has(candidate.action_token))
    ),
    ...added,
  ];
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
