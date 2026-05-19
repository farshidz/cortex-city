import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import type { ReviewSummary } from "./types";
import { snapshotCortex } from "./cortex-git";
import { ensureCortexDir } from "./store";

const REVIEWS_FILE = path.join(process.cwd(), ".cortex", "reviews.json");

let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => T): Promise<T> {
  const result = writeLock.then(fn);
  writeLock = result.then(() => {}, () => {});
  return result;
}

type ReviewMap = Record<string, ReviewSummary>;

function readMap(): ReviewMap {
  ensureCortexDir();
  if (!existsSync(REVIEWS_FILE)) return {};
  try {
    const raw = readFileSync(REVIEWS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ReviewMap;
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

export function upsertReviewSummary(entry: ReviewSummary): Promise<ReviewSummary> {
  return withWriteLock(() => {
    const map = readMap();
    map[entry.pr_url] = entry;
    writeMapLocked(map);
    return entry;
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
    const next = { ...current, ...updates, pr_url: prUrl } as ReviewSummary;
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
