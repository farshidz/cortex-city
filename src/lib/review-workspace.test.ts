import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTempWorkspace } from "./test-harness";
import {
  createReviewWorkspace,
  markReviewWorkspaceActive,
  removeReviewWorkspace,
  removeReviewWorkspaceBeforeStart,
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

test("review workspaces carry an ownership marker and are disposable", async () => {
  const appRoot = createTempWorkspace("review-workspace-app-");
  const configuredRoot = path.join(appRoot, "separate-volume");
  const workspace = createReviewWorkspace(
    "codex",
    { CORTEX_REVIEW_WORKSPACE_ROOT: configuredRoot },
    appRoot
  );

  assert.equal(path.dirname(workspace.path), realpathSync(configuredRoot));
  assert.match(path.basename(workspace.path), new RegExp(`^${REVIEW_WORKSPACE_PREFIX}`));
  assert.equal(workspace.markerPath, path.join(workspace.path, REVIEW_WORKSPACE_MARKER));
  const marker = JSON.parse(readFileSync(workspace.markerPath, "utf-8"));
  assert.equal(marker.owner, "cortex-city");
  assert.equal(marker.purpose, "review-runtime");
  assert.equal(marker.runtime, "codex");
  assert.equal(marker.launcher_pid, process.pid);

  markReviewWorkspaceActive(workspace, 1234);
  const activeMarker = JSON.parse(readFileSync(workspace.markerPath, "utf-8"));
  assert.equal(activeMarker.runtime_pid, 1234);
  assert.match(activeMarker.updated_at, /^\d{4}-\d{2}-\d{2}T/);

  writeFileSync(path.join(workspace.path, "artifact"), "temporary\n");
  const removal = removeReviewWorkspace(workspace.path);
  assert.ok(removal instanceof Promise);
  await removal;
  assert.equal(existsSync(workspace.path), false);

  // Cleanup is intentionally idempotent for competing completion paths.
  await removeReviewWorkspace(workspace.path);

  const setupFailureWorkspace = createReviewWorkspace("claude", {}, appRoot);
  removeReviewWorkspaceBeforeStart(setupFailureWorkspace.path);
  assert.equal(existsSync(setupFailureWorkspace.path), false);
});
