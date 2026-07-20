import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTempWorkspace } from "./test-harness";
import {
  createReviewWorkspace,
  markReviewWorkspaceActive,
  releaseReviewWorkspace,
  releaseReviewWorkspaceBeforeStart,
  removeFinalReviewWorkspace,
  resolveReviewWorkspacePath,
  resolveReviewWorkspaceRoot,
  REVIEW_WORKSPACE_MARKER,
  REVIEW_WORKSPACE_PREFIX,
} from "./review-workspace";

test("resolveReviewWorkspaceRoot uses the app tmp directory by default", () => {
  const appRoot = path.join(os.tmpdir(), "cortex-app");
  assert.equal(
    resolveReviewWorkspaceRoot({}, appRoot),
    path.join(appRoot, "tmp", "reviews")
  );
  assert.equal(
    resolveReviewWorkspaceRoot(
      { CORTEX_REVIEW_WORKSPACE_ROOT: "scratch/reviews" },
      appRoot
    ),
    path.join(appRoot, "scratch", "reviews")
  );
  assert.equal(
    resolveReviewWorkspaceRoot(
      { CORTEX_REVIEW_WORKSPACE_ROOT: "   " },
      appRoot
    ),
    path.join(appRoot, "tmp", "reviews")
  );
});

test("active reviews reuse their owned workspace until final cleanup", async () => {
  const appRoot = createTempWorkspace("review-workspace-app-");
  const configuredRoot = path.join(appRoot, "separate-volume");
  const env = { CORTEX_REVIEW_WORKSPACE_ROOT: configuredRoot };
  const reviewKey = "https://github.com/acme/widget/pull/42";
  const workspace = createReviewWorkspace("codex", reviewKey, env, appRoot);

  assert.equal(path.dirname(workspace.path), realpathSync(configuredRoot));
  assert.equal(
    workspace.path,
    realpathSync(resolveReviewWorkspacePath(reviewKey, env, appRoot))
  );
  assert.match(path.basename(workspace.path), new RegExp(`^${REVIEW_WORKSPACE_PREFIX}`));
  assert.equal(workspace.markerPath, path.join(workspace.path, REVIEW_WORKSPACE_MARKER));
  const marker = JSON.parse(readFileSync(workspace.markerPath, "utf-8"));
  assert.equal(marker.owner, "cortex-city");
  assert.equal(marker.purpose, "review-runtime");
  assert.equal(marker.review_key, reviewKey);
  assert.equal(marker.runtime, "codex");

  markReviewWorkspaceActive(workspace, 1234);
  writeFileSync(path.join(workspace.path, "artifact"), "keep between runs\n");
  await releaseReviewWorkspace(workspace, 1234);
  assert.equal(existsSync(workspace.path), true);

  const reused = createReviewWorkspace("codex", reviewKey, env, appRoot);
  assert.equal(reused.path, workspace.path);
  assert.equal(existsSync(path.join(reused.path, "artifact")), true);

  markReviewWorkspaceActive(reused, process.pid);
  assert.equal(await removeFinalReviewWorkspace(reviewKey, env, appRoot), false);
  assert.equal(existsSync(reused.path), true);

  await releaseReviewWorkspace(reused, process.pid);
  assert.equal(await removeFinalReviewWorkspace(reviewKey, env, appRoot), true);
  assert.equal(existsSync(reused.path), false);
  assert.equal(await removeFinalReviewWorkspace(reviewKey, env, appRoot), true);
});

test("ad hoc review workspaces remain disposable", () => {
  const appRoot = createTempWorkspace("review-workspace-disposable-");
  const workspace = createReviewWorkspace("claude", undefined, {}, appRoot);
  assert.equal(workspace.disposable, true);
  releaseReviewWorkspaceBeforeStart(workspace);
  assert.equal(existsSync(workspace.path), false);
});

test("final cleanup refuses a workspace whose ownership marker changed", async () => {
  const appRoot = createTempWorkspace("review-workspace-ownership-");
  const reviewKey = "https://github.com/acme/widget/pull/7";
  const workspace = createReviewWorkspace("codex", reviewKey, {}, appRoot);
  const marker = JSON.parse(readFileSync(workspace.markerPath, "utf-8"));
  writeFileSync(
    workspace.markerPath,
    `${JSON.stringify({ ...marker, review_key: "another-review" })}\n`
  );

  assert.equal(await removeFinalReviewWorkspace(reviewKey, {}, appRoot), false);
  assert.equal(existsSync(workspace.path), true);
});
