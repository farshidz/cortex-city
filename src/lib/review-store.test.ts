import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const REVIEW_STORE_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/lib/review-store.ts")
).href;

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "review-store-test-"));
}

function runStoreScript(workspace: string, body: string) {
  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import * as store from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
        "(async () => {",
        body,
        "})().catch((error) => {",
        "  console.error(error);",
        "  process.exit(1);",
        "});",
      ].join("\n"),
    ],
    {
      cwd: workspace,
      encoding: "utf-8",
    }
  );
  return JSON.parse(output.trim().split(/\r?\n/).pop()!);
}

function sampleReviewLiteral(prUrl: string) {
  return {
    pr_url: prUrl,
    pr_number: 1,
    repo_slug: "acme/widget",
    title: "Add fizzbuzz",
    author: "octocat",
    head_sha: "abc123",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    summary: "",
    generated_at: "",
  };
}

test("readReviewSummaries returns an empty array when no file exists", () => {
  const workspace = createTempWorkspace();
  const result = runStoreScript(
    workspace,
    "console.log(JSON.stringify(store.readReviewSummaries()));"
  );
  assert.deepEqual(result, []);
});

test("upsertReviewSummary writes a new entry keyed by pr_url", () => {
  const workspace = createTempWorkspace();
  const entry = sampleReviewLiteral("https://github.com/acme/widget/pull/1");
  const result = runStoreScript(
    workspace,
    `
      const entry = ${JSON.stringify(entry)};
      const saved = await store.upsertReviewSummary(entry);
      console.log(JSON.stringify({
        saved,
        all: store.readReviewSummaries(),
        fetched: store.getReviewSummary(entry.pr_url),
      }));
    `
  );

  assert.equal(result.saved.pr_url, entry.pr_url);
  assert.equal(result.saved.review_status, "pending_summary");
  assert.equal(result.saved.review_state, "queued");
  assert.deepEqual(result.all, [result.saved]);
  assert.deepEqual(result.fetched, result.saved);

  const persisted = JSON.parse(
    readFileSync(path.join(workspace, ".cortex", "reviews.json"), "utf-8")
  );
  assert.equal(Object.keys(persisted).length, 1);
  assert.equal(persisted[entry.pr_url].pr_url, entry.pr_url);
  assert.equal(persisted[entry.pr_url].review_status, "pending_summary");
  assert.equal(persisted[entry.pr_url].review_state, "queued");
});

test("upsertReviewSummary overwrites existing entries with the same pr_url", () => {
  const workspace = createTempWorkspace();
  const entry = sampleReviewLiteral("https://github.com/acme/widget/pull/1");
  const result = runStoreScript(
    workspace,
    `
      const entry = ${JSON.stringify(entry)};
      await store.upsertReviewSummary(entry);
      await store.upsertReviewSummary({
        ...entry,
        title: "Add fizzbuzz (v2)",
        summary: "second pass",
        generated_at: "2026-05-02T00:00:00.000Z",
      });
      console.log(JSON.stringify(store.getReviewSummary(entry.pr_url)));
    `
  );
  assert.equal(result.title, "Add fizzbuzz (v2)");
  assert.equal(result.summary, "second pass");
  assert.equal(result.generated_at, "2026-05-02T00:00:00.000Z");
  assert.equal(result.review_status, "needs_review");
  assert.equal(result.review_state, "needs_review");
});

test("patchReviewSummary merges updates and returns the patched entry", () => {
  const workspace = createTempWorkspace();
  const entry = sampleReviewLiteral("https://github.com/acme/widget/pull/1");
  const result = runStoreScript(
    workspace,
    `
      const entry = ${JSON.stringify(entry)};
      await store.upsertReviewSummary(entry);
      const patched = await store.patchReviewSummary(entry.pr_url, {
        final_at: "2026-05-03T00:00:00.000Z",
      });
      console.log(JSON.stringify({
        patched,
        fetched: store.getReviewSummary(entry.pr_url),
      }));
    `
  );

  assert.equal(result.patched.final_at, "2026-05-03T00:00:00.000Z");
  assert.equal(result.patched.review_status, "final");
  assert.equal(result.patched.review_state, "archived");
  assert.equal(result.patched.title, "Add fizzbuzz");
  assert.deepEqual(result.fetched, result.patched);
});

test("readReviewSummaries and readReviewSummaryMap backfill review_status and review_state", () => {
  const workspace = createTempWorkspace();
  const entry = {
    ...sampleReviewLiteral("https://github.com/acme/widget/pull/1"),
    summary: "Ready summary",
    my_last_review_sha: "old-sha",
    review_status: "up_to_date",
  };
  const result = runStoreScript(
    workspace,
    `
      const fs = await import("node:fs");
      const path = await import("node:path");
      const cortexDir = path.join(process.cwd(), ".cortex");
      fs.mkdirSync(cortexDir, { recursive: true });
      fs.writeFileSync(
        path.join(cortexDir, "reviews.json"),
        JSON.stringify({ [${JSON.stringify(entry.pr_url)}]: ${JSON.stringify(entry)} })
      );
      const list = store.readReviewSummaries();
      const map = store.readReviewSummaryMap();
      console.log(JSON.stringify({
        list: list[0],
        mapEntry: map[${JSON.stringify(entry.pr_url)}],
      }));
    `
  );

  assert.equal(result.list.review_status, "new_commits");
  assert.equal(result.mapEntry.review_status, "new_commits");
  // Legacy "up_to_date" record with a current summary but no verdict and a
  // mismatched review SHA backfills to needs_review under the merged model.
  assert.equal(result.list.review_state, "needs_review");
  assert.equal(result.mapEntry.review_state, "needs_review");
  assert.equal(result.list.summary_head_sha, "abc123");
  assert.equal(result.mapEntry.summary_head_sha, "abc123");
});

test("patchReviewSummary returns undefined for unknown pr_urls", () => {
  const workspace = createTempWorkspace();
  const result = runStoreScript(
    workspace,
    `
      const patched = await store.patchReviewSummary(
        "https://github.com/missing/repo/pull/9",
        { summary: "noop" }
      );
      console.log(JSON.stringify({ patched: patched ?? null }));
    `
  );
  assert.equal(result.patched, null);
});

test("deleteReviewSummary removes only the matching entry", () => {
  const workspace = createTempWorkspace();
  const a = sampleReviewLiteral("https://github.com/acme/widget/pull/1");
  const b = sampleReviewLiteral("https://github.com/acme/widget/pull/2");
  const result = runStoreScript(
    workspace,
    `
      await store.upsertReviewSummary(${JSON.stringify(a)});
      await store.upsertReviewSummary(${JSON.stringify(b)});
      await store.deleteReviewSummary(${JSON.stringify(a.pr_url)});
      console.log(JSON.stringify({
        remaining: store.readReviewSummaries().map((r) => r.pr_url),
        missing: store.getReviewSummary(${JSON.stringify(a.pr_url)}),
      }));
    `
  );
  assert.deepEqual(result.remaining, [b.pr_url]);
  assert.equal(result.missing, undefined);
});

test("concurrent upserts persist both entries without dropping fields", () => {
  const workspace = createTempWorkspace();
  const a = sampleReviewLiteral("https://github.com/acme/widget/pull/1");
  const b = sampleReviewLiteral("https://github.com/acme/widget/pull/2");
  const result = runStoreScript(
    workspace,
    `
      await Promise.all([
        store.upsertReviewSummary(${JSON.stringify(a)}),
        store.upsertReviewSummary(${JSON.stringify(b)}),
      ]);
      const map = store.readReviewSummaryMap();
      console.log(JSON.stringify({
        keys: Object.keys(map).sort(),
        sample: map[${JSON.stringify(a.pr_url)}],
      }));
    `
  );
  assert.deepEqual(result.keys, [a.pr_url, b.pr_url]);
  assert.equal(result.sample.repo_slug, "acme/widget");
});

test("readReviewSummaryMap recovers gracefully from malformed JSON on disk", () => {
  const workspace = createTempWorkspace();
  const cortexDir = path.join(workspace, ".cortex");
  execFileSync("mkdir", ["-p", cortexDir]);
  // Drop a non-object payload to ensure the reader doesn't blow up.
  execFileSync("bash", [
    "-c",
    `echo '[not json' > ${JSON.stringify(path.join(cortexDir, "reviews.json"))}`,
  ]);
  const result = runStoreScript(
    workspace,
    "console.log(JSON.stringify(store.readReviewSummaryMap()));"
  );
  assert.deepEqual(result, {});
});
