import { statfsSync } from "fs";

export const DEFAULT_MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;

export interface DiskSpaceStatus {
  path: string;
  freeBytes: number;
  minFreeBytes: number;
  ok: boolean;
}

function parseMinFreeDiskBytes(): number {
  const raw = process.env.CORTEX_MIN_FREE_DISK_BYTES;
  if (raw == null || raw.trim() === "") return DEFAULT_MIN_FREE_DISK_BYTES;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MIN_FREE_DISK_BYTES;
  }

  return Math.floor(parsed);
}

function formatBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${gib.toFixed(1)}GiB`;

  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${mib.toFixed(1)}MiB`;

  return `${bytes}B`;
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

  throw new Error(
    `Low disk space before ${context}: ${formatBytes(status.freeBytes)} available at ` +
      `${status.path}; require at least ${formatBytes(status.minFreeBytes)}.`
  );
}
