import { statfsSync } from "fs";

export const DEFAULT_MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_REVIEW_MIN_FREE_DISK_BYTES = 15 * 1024 * 1024 * 1024;
export const DEFAULT_REVIEW_DISK_CHECK_INTERVAL_MS = 5_000;

export interface DiskSpaceStatus {
  path: string;
  freeBytes: number;
  minFreeBytes: number;
  ok: boolean;
}

export class LowDiskSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LowDiskSpaceError";
  }
}

function parseNonNegativeNumber(
  raw: string | undefined,
  fallback: number
): number {
  if (raw == null || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function parseMinFreeDiskBytes(): number {
  return parseNonNegativeNumber(
    process.env.CORTEX_MIN_FREE_DISK_BYTES,
    DEFAULT_MIN_FREE_DISK_BYTES
  );
}

export function resolveReviewMinFreeDiskBytes(): number {
  return parseNonNegativeNumber(
    process.env.CORTEX_REVIEW_MIN_FREE_DISK_BYTES,
    DEFAULT_REVIEW_MIN_FREE_DISK_BYTES
  );
}

export function resolveReviewDiskCheckIntervalMs(): number {
  return Math.max(
    100,
    parseNonNegativeNumber(
      process.env.CORTEX_REVIEW_DISK_CHECK_INTERVAL_MS,
      DEFAULT_REVIEW_DISK_CHECK_INTERVAL_MS
    )
  );
}

export function formatBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${gib.toFixed(1)}GiB`;

  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${mib.toFixed(1)}MiB`;

  return `${bytes}B`;
}

function lowDiskError(
  timing: "before" | "during",
  context: string,
  status: DiskSpaceStatus
): LowDiskSpaceError {
  return new LowDiskSpaceError(
    `Low disk space ${timing} ${context}: ${formatBytes(status.freeBytes)} available at ` +
      `${status.path}; require at least ${formatBytes(status.minFreeBytes)}.`
  );
}

export function getDiskSpaceStatus(
  targetPath = process.cwd(),
  minFreeBytes = parseMinFreeDiskBytes()
): DiskSpaceStatus {
  const stats = statfsSync(targetPath);
  const freeBytes = stats.bavail * stats.bsize;
  return {
    path: targetPath,
    freeBytes,
    minFreeBytes,
    ok: minFreeBytes <= 0 || freeBytes >= minFreeBytes,
  };
}

export function assertSufficientDiskSpace(
  context: string,
  targetPath = process.cwd()
): void {
  if (process.env.CORTEX_DISABLE_DISK_GUARD === "1") return;

  const status = getDiskSpaceStatus(targetPath);
  if (status.ok) return;

  throw lowDiskError("before", context, status);
}

export type DiskSpaceStatusReader = (
  targetPath: string,
  minFreeBytes: number
) => DiskSpaceStatus;

export interface ReviewDiskGuardOptions {
  targetPath?: string;
  minFreeBytes?: number;
  checkIntervalMs?: number;
  /** Dependency injection for focused tests; production uses statfsSync. */
  readStatus?: DiskSpaceStatusReader;
}

function reviewDiskSpaceStatus(
  options: ReviewDiskGuardOptions = {}
): DiskSpaceStatus {
  const targetPath = options.targetPath || process.cwd();
  const minFreeBytes = options.minFreeBytes ?? resolveReviewMinFreeDiskBytes();
  return (options.readStatus || getDiskSpaceStatus)(targetPath, minFreeBytes);
}

export function assertSufficientReviewDiskSpace(
  context: string,
  options: ReviewDiskGuardOptions = {}
): void {
  if (process.env.CORTEX_DISABLE_DISK_GUARD === "1") return;

  const status = reviewDiskSpaceStatus(options);
  if (status.ok) return;
  throw lowDiskError("before", context, status);
}

/**
 * Polls the filesystem used by a running reviewer. The callback fires once
 * when the reserve is crossed and the returned function cancels the monitor.
 */
export function monitorReviewDiskSpace(
  context: string,
  onLowDisk: (error: LowDiskSpaceError) => void,
  options: ReviewDiskGuardOptions = {}
): () => void {
  if (process.env.CORTEX_DISABLE_DISK_GUARD === "1") return () => {};
  const minFreeBytes = options.minFreeBytes ?? resolveReviewMinFreeDiskBytes();
  if (minFreeBytes <= 0) return () => {};

  let stopped = false;
  const intervalMs = Math.max(
    100,
    options.checkIntervalMs ?? resolveReviewDiskCheckIntervalMs()
  );
  const timer = setInterval(() => {
    if (stopped) return;
    let status: DiskSpaceStatus;
    try {
      status = reviewDiskSpaceStatus({ ...options, minFreeBytes });
    } catch (error) {
      stopped = true;
      clearInterval(timer);
      const message = error instanceof Error ? error.message : String(error);
      onLowDisk(
        new LowDiskSpaceError(
          `Unable to check disk space during ${context}; stopping the review: ${message}`
        )
      );
      return;
    }
    if (status.ok) return;

    stopped = true;
    clearInterval(timer);
    onLowDisk(lowDiskError("during", context, status));
  }, intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
