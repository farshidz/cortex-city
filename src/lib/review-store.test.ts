import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

function spawnStoreScript(
  workspace: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env
) {
  const child = spawn(
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
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
  assert.equal(result.saved.source, "inbound");
  assert.equal(result.saved.review_status, "pending_summary");
  assert.equal(result.saved.review_state, "queued");
  assert.deepEqual(result.all, [result.saved]);
  assert.deepEqual(result.fetched, result.saved);

  const persisted = JSON.parse(
    readFileSync(path.join(workspace, ".cortex", "reviews.json"), "utf-8")
  );
  assert.equal(Object.keys(persisted).length, 1);
  assert.equal(persisted[entry.pr_url].pr_url, entry.pr_url);
  assert.equal(persisted[entry.pr_url].source, "inbound");
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

test("clearReviewRunIfMatching cannot clear a newer run owner", () => {
  const workspace = createTempWorkspace();
  const entry = {
    ...sampleReviewLiteral("https://github.com/acme/widget/pull/41"),
    current_run_pid: 4100,
    current_run_id: "new-owner",
  };
  const result = runStoreScript(
    workspace,
    `
      await store.upsertReviewSummary(${JSON.stringify(entry)});
      const stale = await store.clearReviewRunIfMatching(
        ${JSON.stringify(entry.pr_url)},
        4000,
        "old-owner"
      );
      const afterStale = store.getReviewSummary(${JSON.stringify(entry.pr_url)});
      const cleared = await store.clearReviewRunIfMatching(
        ${JSON.stringify(entry.pr_url)},
        4100,
        "new-owner"
      );
      console.log(JSON.stringify({
        stale: stale ?? null,
        afterStale,
        cleared,
      }));
    `
  );

  assert.equal(result.stale, null);
  assert.equal(result.afterStale.current_run_pid, 4100);
  assert.equal(result.afterStale.current_run_id, "new-owner");
  assert.equal(result.cleared.current_run_pid, undefined);
  assert.equal(result.cleared.current_run_id, undefined);
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
  assert.equal(result.list.source, "inbound");
  assert.equal(result.mapEntry.source, "inbound");
});

test("task review records retain task context and discard inbound decision signals", () => {
  const workspace = createTempWorkspace();
  const entry = {
    ...sampleReviewLiteral("https://github.com/acme/widget/pull/8"),
    source: "task",
    task_id: "task-8",
    task_title: "Ship widget cache",
    task_description: "Avoid duplicate fetches.",
    task_plan: "Memoize by widget ID.",
    summary: "Clean review",
    my_approval_sha: "abc123",
    my_changes_requested_sha: "abc123",
  };
  const result = runStoreScript(
    workspace,
    `
      const saved = await store.upsertReviewSummary(${JSON.stringify(entry)});
      console.log(JSON.stringify(saved));
    `
  );

  assert.equal(result.source, "task");
  assert.equal(result.task_id, "task-8");
  assert.equal(result.task_title, "Ship widget cache");
  assert.equal(result.task_description, "Avoid duplicate fetches.");
  assert.equal(result.task_plan, "Memoize by widget ID.");
  assert.equal(result.my_approval_sha, undefined);
  assert.equal(result.my_changes_requested_sha, undefined);
  assert.notEqual(result.review_state, "approved");
  assert.notEqual(result.review_state, "changes_requested");
  assert.equal(result.review_status, "up_to_date");
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

test("deleteReviewSummaryIf rechecks the latest record before deleting", () => {
  const workspace = createTempWorkspace();
  const entry = sampleReviewLiteral("https://github.com/acme/widget/pull/12");
  const result = runStoreScript(
    workspace,
    `
      await store.upsertReviewSummary(${JSON.stringify(entry)});
      const skipped = await store.deleteReviewSummaryIf(
        ${JSON.stringify(entry.pr_url)},
        (current) => current.current_run_id === "missing-owner"
      );
      await store.patchReviewSummary(${JSON.stringify(entry.pr_url)}, {
        current_run_pid: 7012,
        current_run_id: "new-owner",
      });
      const protectedDelete = await store.deleteReviewSummaryIf(
        ${JSON.stringify(entry.pr_url)},
        (current) => current.current_run_pid == null
      );
      const protectedEntry = store.getReviewSummary(${JSON.stringify(entry.pr_url)});
      const deleted = await store.deleteReviewSummaryIf(
        ${JSON.stringify(entry.pr_url)},
        (current) => current.current_run_id === "new-owner"
      );
      console.log(JSON.stringify({
        skipped,
        protectedDelete,
        protectedPid: protectedEntry?.current_run_pid,
        deleted,
        remaining: store.getReviewSummary(${JSON.stringify(entry.pr_url)}) ?? null,
      }));
    `
  );

  assert.equal(result.skipped, false);
  assert.equal(result.protectedDelete, false);
  assert.equal(result.protectedPid, 7012);
  assert.equal(result.deleted, true);
  assert.equal(result.remaining, null);
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

test("separate processes serialize review store writes", async () => {
  const workspace = createTempWorkspace();
  const a = sampleReviewLiteral("https://github.com/acme/widget/pull/31");
  const b = sampleReviewLiteral("https://github.com/acme/widget/pull/32");
  const first = spawnStoreScript(
    workspace,
    `
      for (let i = 0; i < 20; i++) {
        await store.upsertReviewSummary({
          ...${JSON.stringify(a)},
          title: "writer-a-" + i,
        });
      }
    `
  );
  const second = spawnStoreScript(
    workspace,
    `
      for (let i = 0; i < 20; i++) {
        await store.upsertReviewSummary({
          ...${JSON.stringify(b)},
          title: "writer-b-" + i,
        });
      }
    `
  );

  const [firstResult, secondResult] = await Promise.all([
    first.done,
    second.done,
  ]);
  assert.equal(firstResult.code, 0, firstResult.stderr);
  assert.equal(secondResult.code, 0, secondResult.stderr);

  const result = runStoreScript(
    workspace,
    `
      const map = store.readReviewSummaryMap();
      console.log(JSON.stringify({
        keys: Object.keys(map).sort(),
        titles: [map[${JSON.stringify(a.pr_url)}].title, map[${JSON.stringify(b.pr_url)}].title],
      }));
    `
  );
  assert.deepEqual(result.keys, [a.pr_url, b.pr_url]);
  assert.deepEqual(result.titles, ["writer-a-19", "writer-b-19"]);
});

test("a separate process recovers a review store lock after its owner dies", async () => {
  const workspace = createTempWorkspace();
  const marker = path.join(workspace, "review-store-lock-held");
  const entry = sampleReviewLiteral("https://github.com/acme/widget/pull/33");
  const env = {
    ...process.env,
    CORTEX_REVIEW_STORE_LOCK_STALE_MS: "5000",
  };
  const holder = spawnStoreScript(
    workspace,
    `
      await store.mutateReviewSummary(
        ${JSON.stringify(entry.pr_url)},
        () => {
          require("node:fs").writeFileSync(${JSON.stringify(marker)}, "held");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
          return ${JSON.stringify(entry)};
        }
      );
    `,
    env
  );
  await waitForFile(marker);
  assert.ok(holder.child.pid);
  process.kill(-holder.child.pid, "SIGKILL");
  const holderResult = await holder.done;
  assert.equal(holderResult.signal, "SIGKILL");

  const recovery = spawnStoreScript(
    workspace,
    `await store.upsertReviewSummary(${JSON.stringify(entry)});`,
    env
  );
  const recoveryResult = await recovery.done;
  assert.equal(recoveryResult.code, 0, recoveryResult.stderr);

  const result = runStoreScript(
    workspace,
    `console.log(JSON.stringify(store.getReviewSummary(${JSON.stringify(entry.pr_url)})));`
  );
  assert.equal(result.pr_url, entry.pr_url);
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
