export const REVIEWER_GITHUB_COMMENT_PREFIX =
  "**🤖[Cortex City Reviewer]**";

export const REVIEWER_HUMAN_DECISION_COMMENT_PREFIX =
  `${REVIEWER_GITHUB_COMMENT_PREFIX} **Human decision needed:**`;

export const REVIEWER_SELF_APPROVAL_COMMENT_PREFIX =
  `${REVIEWER_GITHUB_COMMENT_PREFIX} **Ready for manual approval:**`;

export function isReviewerTimelineComment(body?: string | null): boolean {
  const normalized = body?.trimStart();
  return Boolean(
    normalized?.startsWith(REVIEWER_HUMAN_DECISION_COMMENT_PREFIX) ||
      normalized?.startsWith(REVIEWER_SELF_APPROVAL_COMMENT_PREFIX)
  );
}
