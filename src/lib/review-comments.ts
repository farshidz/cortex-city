export const REVIEWER_GITHUB_COMMENT_PREFIX =
  "**🤖[Cortex City Reviewer]**";

export const REVIEWER_HUMAN_DECISION_COMMENT_PREFIX =
  `${REVIEWER_GITHUB_COMMENT_PREFIX} **Human decision needed:**`;

const REVIEWER_HUMAN_DECISION_COMMENT_TOKEN_PREFIX =
  "<!-- cortex-city-review-decision:";

export function reviewerHumanDecisionCommentMarker(token: string): string {
  return `${REVIEWER_HUMAN_DECISION_COMMENT_TOKEN_PREFIX}${token} -->`;
}
