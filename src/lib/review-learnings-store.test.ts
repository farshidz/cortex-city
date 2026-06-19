import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  createTempWorkspace,
  moduleUrl,
  runTsxScript,
} from "./test-harness";

const LEARNINGS_STORE_MODULE_URL = moduleUrl(
  "src/lib/review-learnings-store.ts"
);

function runStoreScript(workspace: string, body: string) {
  return runTsxScript(
    workspace,
    [`import * as store from ${JSON.stringify(LEARNINGS_STORE_MODULE_URL)};`],
    body
  );
}

test("readReviewLearnings returns an empty string when absent", () => {
  const workspace = createTempWorkspace("review-learnings-store-absent-");
  const result = runStoreScript(
    workspace,
    `
      console.log(JSON.stringify({ content: store.readReviewLearnings() }));
    `
  );

  assert.deepEqual(result, { content: "" });
});

test("writeReviewLearnings round-trips Markdown content", () => {
  const workspace = createTempWorkspace("review-learnings-store-roundtrip-");
  const content = "# Review learnings\n\n- Prefer small diffs.\n";
  const result = runStoreScript(
    workspace,
    `
      await store.writeReviewLearnings(${JSON.stringify(content)});
      console.log(JSON.stringify({ content: store.readReviewLearnings() }));
    `
  );

  assert.deepEqual(result, { content });
  const file = path.join(workspace, ".cortex", "review-learnings.md");
  assert.equal(readFileSync(file, "utf-8"), content);
});

test("compareAndWriteReviewLearnings refuses stale expected content", () => {
  const workspace = createTempWorkspace("review-learnings-store-compare-");
  const original = "# Review learnings\n\n- Original guidance.\n";
  const manualEdit = "# Review learnings\n\n- Manual guidance.\n";
  const retroRewrite = "# Review learnings\n\n- Retro guidance.\n";
  const result = runStoreScript(
    workspace,
    `
      await store.writeReviewLearnings(${JSON.stringify(original)});
      const firstWrite = await store.compareAndWriteReviewLearnings(
        ${JSON.stringify(original)},
        ${JSON.stringify(manualEdit)}
      );
      const staleWrite = await store.compareAndWriteReviewLearnings(
        ${JSON.stringify(original)},
        ${JSON.stringify(retroRewrite)}
      );
      console.log(JSON.stringify({
        firstWrite,
        staleWrite,
        content: store.readReviewLearnings(),
      }));
    `
  );

  assert.equal(result.firstWrite, true);
  assert.equal(result.staleWrite, false);
  assert.equal(result.content, manualEdit);
});

test("concurrent writes serialize without leaving temp files", () => {
  const workspace = createTempWorkspace("review-learnings-store-concurrent-");
  const result = runStoreScript(
    workspace,
    `
      await Promise.all([
        store.writeReviewLearnings("first\\n"),
        store.writeReviewLearnings("second\\n"),
        store.writeReviewLearnings("third\\n"),
      ]);
      const fs = await import("node:fs");
      const path = await import("node:path");
      const cortexDir = path.join(process.cwd(), ".cortex");
      console.log(JSON.stringify({
        content: store.readReviewLearnings(),
        tempFiles: fs.readdirSync(cortexDir).filter((name) => name.includes(".tmp")),
      }));
    `
  );

  assert.match(result.content, /^(first|second|third)\n$/);
  assert.deepEqual(result.tempFiles, []);
  assert.equal(
    existsSync(path.join(workspace, ".cortex", "review-learnings.md")),
    true
  );
});
