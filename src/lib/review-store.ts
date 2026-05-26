import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { withReviewStatus } from "./review-status";
import type { ReviewStatus, ReviewSummary } from "./types";
import { snapshotCortex } from "./cortex-git";
import { ensureCortexDir } from "./store";

const REVIEWS_FILE = path.join(process.cwd(), ".cortex", "reviews.json");

let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => T): Promise<T> {
  const result = writeLock.then(fn);
  writeLock = result.then(() => {}, () => {});
  return result;
}

type ReviewSummaryInput = Omit<ReviewSummary, "review_status"> & {
  review_status?: ReviewStatus;
};
type ReviewMap = Record<string, ReviewSummary>;
type RawReviewMap = Record<string, ReviewSummaryInput>;

function normalizeReview(review: ReviewSummaryInput): ReviewSummary {
  const withoutLegacyState = { ...review } as ReviewSummaryInput & {
    review_state?: unknown;
  };
  delete withoutLegacyState.review_state;
  if (
    withoutLegacyState.summary?.trim() &&
    !withoutLegacyState.summary_head_sha
  ) {
    withoutLegacyState.summary_head_sha = withoutLegacyState.head_sha;
  }
  return withReviewStatus(withoutLegacyState) as ReviewSummary;
}

function normalizeMap(map: RawReviewMap): ReviewMap {
  return Object.fromEntries(
    Object.entries(map).map(([prUrl, review]) => [
      prUrl,
      normalizeReview({ ...review, pr_url: review.pr_url || prUrl }),
    ])
  );
}

function readMap(): ReviewMap {
  ensureCortexDir();
  if (!existsSync(REVIEWS_FILE)) return {};
  try {
    const raw = readFileSync(REVIEWS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return normalizeMap(parsed as RawReviewMap);
    }
    return {};
  } catch {
    return {};
  }
}

function writeMapLocked(map: ReviewMap): void {
  ensureCortexDir();
  writeFileSync(REVIEWS_FILE, JSON.stringify(map, null, 2));
  snapshotCortex("reviews");
}

export function readReviewSummaries(): ReviewSummary[] {
  return Object.values(readMap());
}

export function readReviewSummaryMap(): ReviewMap {
  return readMap();
}

export function getReviewSummary(prUrl: string): ReviewSummary | undefined {
  return readMap()[prUrl];
}

export function upsertReviewSummary(
  entry: ReviewSummaryInput
): Promise<ReviewSummary> {
  return withWriteLock(() => {
    const map = readMap();
    const normalized = normalizeReview(entry);
    map[entry.pr_url] = normalized;
    writeMapLocked(map);
    return normalized;
  });
}

export function patchReviewSummary(
  prUrl: string,
  updates: Partial<ReviewSummary>
): Promise<ReviewSummary | undefined> {
  return withWriteLock(() => {
    const map = readMap();
    const current = map[prUrl];
    if (!current) return undefined;
    const next = normalizeReview({ ...current, ...updates, pr_url: prUrl });
    map[prUrl] = next;
    writeMapLocked(map);
    return next;
  });
}

export function deleteReviewSummary(prUrl: string): Promise<void> {
  return withWriteLock(() => {
    const map = readMap();
    if (!(prUrl in map)) return;
    delete map[prUrl];
    writeMapLocked(map);
  });
}
