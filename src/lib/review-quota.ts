import { getCodexQuotaStatus } from "./agent-status";
import { getPRUserLogin, postReviewQuotaRefusal } from "./github";
import type { AgentQuotaStatus, OrchestratorConfig, ReviewRequest } from "./types";

export class ReviewQuotaDeferredError extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The account-wide Codex bucket can put its weekly window in either slot. */
export function codexWeeklyUsedPercent(
  status: AgentQuotaStatus
): number | undefined {
  if (status.state !== "available") return undefined;
  const limits = record(status.quota?.rate_limits);
  if (!limits) return undefined;
  const singleBucket = limits.limitId === "codex" ||
    (!limits.limitId && (limits.primary || limits.secondary));
  const bucket = record(limits.codex) ?? (singleBucket ? limits : undefined);
  if (!bucket) return undefined;
  const percentages = [bucket.primary, bucket.secondary].flatMap((raw) => {
    const window = record(raw);
    return window?.windowDurationMins === 10080 &&
      typeof window.usedPercent === "number" &&
      Number.isFinite(window.usedPercent) &&
      window.usedPercent >= 0
      ? [window.usedPercent]
      : [];
  });
  return percentages.length ? Math.max(...percentages) : undefined;
}

let cachedQuota: { expiresAt: number; status: Promise<AgentQuotaStatus> } | undefined;
function readQuota(): Promise<AgentQuotaStatus> {
  if (!cachedQuota || cachedQuota.expiresAt <= Date.now()) {
    cachedQuota = { expiresAt: Date.now() + 60_000, status: getCodexQuotaStatus() };
  }
  return cachedQuota.status;
}

/** Called under the PR run lock, before creating a runtime or consuming a slot. */
export async function enforceReviewQuota(
  config: Pick<
    OrchestratorConfig,
    "review_author_whitelist" | "review_weekly_usage_limit_percent"
  >,
  request: Pick<ReviewRequest, "author" | "pr_url">,
  deps = { readQuota, getPRUserLogin, postReviewQuotaRefusal }
): Promise<void> {
  const threshold = config.review_weekly_usage_limit_percent;
  if (threshold == null) return;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
    throw new ReviewQuotaDeferredError("Review deferred: weekly Codex usage limit must be an integer between 0 and 100.");
  }
  const whitelist = (config.review_author_whitelist ?? [])
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  if (whitelist.length) {
    const author = request.author.trim() || await deps.getPRUserLogin(request.pr_url);
    if (!author) {
      throw new ReviewQuotaDeferredError("Review deferred: PR author is unavailable.");
    }
    if (whitelist.includes(author.toLowerCase())) return;
  }
  const usage = codexWeeklyUsedPercent(await deps.readQuota());
  if (usage == null) {
    throw new ReviewQuotaDeferredError("Review deferred: weekly Codex usage is unavailable.");
  }
  if (usage < threshold) return;
  await deps.postReviewQuotaRefusal(request.pr_url);
  throw new ReviewQuotaDeferredError("Review refused: the weekly Codex usage limit has been exceeded.");
}
