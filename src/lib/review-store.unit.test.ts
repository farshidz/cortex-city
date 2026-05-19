// In-process tests for review-store exports. The store reads/writes
// .cortex/reviews.json relative to process.cwd() (captured at import time),
// so tests use a unique pr_url namespace and clean up after themselves to
// avoid polluting the real cortex file when running from the repo root.
import test from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";

import * as store from "./review-store";
import type { ReviewSummary } from "./types";

function sample(prUrl: string): ReviewSummary {
  return {
    pr_url: prUrl,
    pr_number: 1,
    repo_slug: "acme/widget",
    title: "test",
    author: "octocat",
    head_sha: "sha",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    summary: "",
    generated_at: "",
  };
}

test("review-store namespace exports are all reachable", () => {
  assert.equal(typeof store.readReviewSummaries, "function");
  assert.equal(typeof store.readReviewSummaryMap, "function");
  assert.equal(typeof store.getReviewSummary, "function");
  assert.equal(typeof store.upsertReviewSummary, "function");
  assert.equal(typeof store.patchReviewSummary, "function");
  assert.equal(typeof store.deleteReviewSummary, "function");
});

test("upsert / patch / delete roundtrip works in-process", async () => {
  const prUrl = `https://github.com/acme/widget/pull/${nanoid(6)}`;
  try {
    await store.upsertReviewSummary(sample(prUrl));
    const fetched = store.getReviewSummary(prUrl);
    assert.equal(fetched?.pr_url, prUrl);

    const patched = await store.patchReviewSummary(prUrl, { summary: "hi" });
    assert.equal(patched?.summary, "hi");

    const allMap = store.readReviewSummaryMap();
    assert.ok(allMap[prUrl]);
    assert.equal(allMap[prUrl].summary, "hi");

    const allList = store.readReviewSummaries();
    assert.ok(allList.find((r) => r.pr_url === prUrl));

    await store.deleteReviewSummary(prUrl);
    assert.equal(store.getReviewSummary(prUrl), undefined);
  } finally {
    // Ensure cleanup even if assertions threw mid-way.
    await store.deleteReviewSummary(prUrl);
  }
});

test("patchReviewSummary returns undefined for unknown pr_urls", async () => {
  const missing = `https://github.com/missing/repo/pull/${nanoid(6)}`;
  const result = await store.patchReviewSummary(missing, { summary: "noop" });
  assert.equal(result, undefined);
});
