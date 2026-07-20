import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSufficientReviewDiskSpace,
  DEFAULT_MIN_FREE_DISK_BYTES,
  DEFAULT_REVIEW_MIN_FREE_DISK_BYTES,
  LowDiskSpaceError,
  monitorReviewDiskSpace,
  type DiskSpaceStatus,
} from "./disk-guard";

function status(freeBytes: number, minFreeBytes: number): DiskSpaceStatus {
  return {
    path: "/review-filesystem",
    freeBytes,
    minFreeBytes,
    ok: minFreeBytes <= 0 || freeBytes >= minFreeBytes,
  };
}

test("review reserve defaults to 15 GiB without changing the task reserve", () => {
  assert.equal(DEFAULT_MIN_FREE_DISK_BYTES, 2 * 1024 ** 3);
  assert.equal(DEFAULT_REVIEW_MIN_FREE_DISK_BYTES, 15 * 1024 ** 3);
});

test("review preflight reports the configured reserve and available space", () => {
  assert.throws(
    () =>
      assertSufficientReviewDiskSpace("launching test review", {
        minFreeBytes: 15 * 1024 ** 3,
        readStatus: (_targetPath, minFreeBytes) =>
          status(3 * 1024 ** 3, minFreeBytes),
      }),
    (error) => {
      assert.ok(error instanceof LowDiskSpaceError);
      assert.match(error.message, /before launching test review/);
      assert.match(error.message, /3\.0GiB available/);
      assert.match(error.message, /at least 15\.0GiB/);
      return true;
    }
  );
});

test("review monitor fires once when free space crosses the reserve", async () => {
  let checks = 0;
  let error: LowDiskSpaceError | undefined;
  const stop = monitorReviewDiskSpace(
    "running test review",
    (failure) => {
      error = failure;
    },
    {
      minFreeBytes: 15 * 1024 ** 3,
      checkIntervalMs: 100,
      readStatus: (_targetPath, minFreeBytes) => {
        checks++;
        return status(14 * 1024 ** 3, minFreeBytes);
      },
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  stop();

  assert.equal(checks, 1);
  assert.ok(error);
  assert.match(error.message, /during running test review/);
  assert.match(error.message, /14\.0GiB available/);
});
