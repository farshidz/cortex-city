// In-process tests for the pure predicates that gate worker phases.
import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldFinalizeCleanupWorktree,
  shouldResetStaleFinalCleanup,
} from "./orchestrator-worker-runtime";
import type { Task } from "./types";

function sample(overrides: Partial<Task> = {}): Task {
  return {
    id: "t",
    title: "t",
    description: "",
    status: "merged",
    agent: "a",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

test("shouldFinalizeCleanupWorktree requires finished cleanup + worktree path + no pid", () => {
  assert.equal(
    shouldFinalizeCleanupWorktree(
      sample({ final_cleanup_state: "finished", worktree_path: "/tmp/x" }),
      false
    ),
    true
  );
  assert.equal(
    shouldFinalizeCleanupWorktree(
      sample({ status: "open", final_cleanup_state: "finished", worktree_path: "/x" }),
      false
    ),
    false
  );
  assert.equal(
    shouldFinalizeCleanupWorktree(
      sample({ final_cleanup_state: "finished", worktree_path: "/x" }),
      true // active pid means a run is still in flight
    ),
    false
  );
});

test("shouldResetStaleFinalCleanup detects running-but-orphaned cleanup state", () => {
  assert.equal(
    shouldResetStaleFinalCleanup(
      sample({ final_cleanup_state: "running" }),
      false
    ),
    true
  );
  assert.equal(
    shouldResetStaleFinalCleanup(
      sample({ final_cleanup_state: "running", current_run_pid: 123 }),
      false
    ),
    false
  );
  assert.equal(
    shouldResetStaleFinalCleanup(
      sample({ final_cleanup_state: "running" }),
      true
    ),
    false
  );
  assert.equal(
    shouldResetStaleFinalCleanup(
      sample({ status: "open", final_cleanup_state: "running" }),
      false
    ),
    false
  );
});
