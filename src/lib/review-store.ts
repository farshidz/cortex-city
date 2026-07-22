import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import * as lockfile from "proper-lockfile";
import { withReviewState, withReviewStatus } from "./review-status";
import type { ReviewState, ReviewStatus, ReviewSummary } from "./types";
import { snapshotCortex } from "./cortex-git";
import { ensureCortexDir } from "./store";

const REVIEWS_FILE = path.join(process.cwd(), ".cortex", "reviews.json");
const REVIEW_STORE_LOCK_TARGET = path.join(
  tmpdir(),
  "cortex-city-review-store-locks",
  createHash("sha256").update(REVIEWS_FILE).digest("hex")
);

let writeLock: Promise<void> = Promise.resolve();
const configuredLockStaleMs = Number(
  process.env.CORTEX_REVIEW_STORE_LOCK_STALE_MS
);
const LOCK_STALE_MS = Number.isFinite(configuredLockStaleMs)
  ? Math.max(5_000, configuredLockStaleMs)
  : 30_000;
const LOCK_UPDATE_MS = Math.max(1_000, Math.floor(LOCK_STALE_MS / 3));

interface AcquiredFileLock {
  release: () => Promise<void>;
  compromised: () => Error | undefined;
}

async function acquireFileLock(): Promise<AcquiredFileLock> {
  ensureCortexDir();
  mkdirSync(path.dirname(REVIEW_STORE_LOCK_TARGET), { recursive: true });
  let compromised: Error | undefined;
  const release = await lockfile.lock(REVIEW_STORE_LOCK_TARGET, {
    realpath: false,
    stale: LOCK_STALE_MS,
    update: LOCK_UPDATE_MS,
    retries: {
      retries: 400,
      factor: 1,
      minTimeout: 25,
      maxTimeout: 25,
    },
    onCompromised: (error) => {
      compromised = error;
    },
  });
  return { release, compromised: () => compromised };
}

function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = writeLock.then(async () => {
    const lock = await acquireFileLock();
    try {
      const value = await fn();
      const compromised = lock.compromised();
      if (compromised) throw compromised;
      return value;
    } finally {
      try {
        await lock.release();
      } catch (error) {
        if (!lock.compromised()) throw error;
      }
    }
  });
  writeLock = result.then(() => {}, () => {});
  return result;
}

type ReviewSummaryInput = Omit<ReviewSummary, "review_status" | "review_state"> & {
  review_status?: ReviewStatus;
  review_state?: ReviewState;
};
type ReviewMap = Record<string, ReviewSummary>;
type RawReviewMap = Record<string, ReviewSummaryInput>;

function normalizeReview(review: ReviewSummaryInput): ReviewSummary {
  const normalized: ReviewSummaryInput = {
    ...review,
    source: review.source === "task" ? "task" : "inbound",
  };
  const decisionCommentIds = Array.isArray(
    normalized.reviewer_human_decision_comment_ids
  )
    ? [
        ...new Set(
          normalized.reviewer_human_decision_comment_ids.filter(
            (id) => Number.isSafeInteger(id) && id > 0
          )
        ),
      ]
    : [];
  normalized.reviewer_human_decision_comment_ids =
    decisionCommentIds.length > 0 ? decisionCommentIds : undefined;
  normalized.pending_reviewer_human_decision_comment_token =
    typeof normalized.pending_reviewer_human_decision_comment_token ===
      "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized.pending_reviewer_human_decision_comment_token
    )
      ? normalized.pending_reviewer_human_decision_comment_token
      : undefined;
  if (normalized.source === "task") {
    // Human approval/change-request signals belong to inbound reviews. They
    // must never make a task owner's own PR look approved or changes-requested.
    normalized.my_approval_sha = undefined;
    normalized.my_changes_requested_sha = undefined;
    normalized.label_only = undefined;
    normalized.self_authored = undefined;
  } else {
    normalized.task_id = undefined;
    normalized.task_title = undefined;
    normalized.task_description = undefined;
    normalized.task_plan = undefined;
    if (normalized.self_authored) {
      normalized.my_approval_sha = undefined;
      normalized.my_changes_requested_sha = undefined;
    }
  }
  if (normalized.summary?.trim() && !normalized.summary_head_sha) {
    normalized.summary_head_sha = normalized.head_sha;
  }
  // Re-derive both the legacy status and the merged state so old records
  // (and any persisted derived fields) backfill from the current inputs.
  return withReviewState(withReviewStatus(normalized)) as ReviewSummary;
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
  const temp = path.join(
    path.dirname(REVIEWS_FILE),
    `.${path.basename(REVIEWS_FILE)}.${process.pid}.${Date.now()}.tmp`
  );
  writeFileSync(temp, JSON.stringify(map, null, 2));
  renameSync(temp, REVIEWS_FILE);
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

export function mutateReviewSummary(
  prUrl: string,
  updater: (
    current: ReviewSummary | undefined
  ) => ReviewSummaryInput | undefined
): Promise<ReviewSummary | undefined> {
  return withWriteLock(() => {
    const map = readMap();
    const next = updater(map[prUrl]);
    if (!next) return undefined;
    const normalized = normalizeReview({ ...next, pr_url: prUrl });
    map[prUrl] = normalized;
    writeMapLocked(map);
    return normalized;
  });
}

export function clearReviewRunIfMatching(
  prUrl: string,
  currentRunPid: number,
  currentRunId?: string
): Promise<ReviewSummary | undefined> {
  return mutateReviewSummary(prUrl, (current) => {
    if (
      !current ||
      current.current_run_pid !== currentRunPid ||
      current.current_run_id !== currentRunId
    ) {
      return undefined;
    }
    return {
      ...current,
      current_run_pid: undefined,
      current_run_id: undefined,
    };
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

export function deleteReviewSummaryIf(
  prUrl: string,
  predicate: (current: ReviewSummary) => boolean
): Promise<boolean> {
  return withWriteLock(() => {
    const map = readMap();
    const current = map[prUrl];
    if (!current || !predicate(current)) return false;
    delete map[prUrl];
    writeMapLocked(map);
    return true;
  });
}
