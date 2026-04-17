import test from "node:test";
import assert from "node:assert/strict";

import { shouldStartFinalCleanup } from "./final-task-cleanup";
import type { Task } from "./types";

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Clean up merged task",
    description: "Verify final cleanup gating",
    status: "merged",
    agent: "cortex-city-swe",
    created_at: "2026-04-17T00:00:00.000Z",
    updated_at: "2026-04-17T00:00:00.000Z",
    ...overrides,
  };
}

test("shouldStartFinalCleanup allows a final task with a worktree to run once", () => {
  assert.equal(
    shouldStartFinalCleanup(
      sampleTask({
        worktree_path: "/tmp/worktree",
      }),
      false
    ),
    true
  );
});

test("shouldStartFinalCleanup skips tasks already in cleanup", () => {
  assert.equal(
    shouldStartFinalCleanup(
      sampleTask({
        worktree_path: "/tmp/worktree",
        final_cleanup_state: "running",
      }),
      false
    ),
    false
  );
});

test("shouldStartFinalCleanup skips tasks whose final cleanup already finished", () => {
  assert.equal(
    shouldStartFinalCleanup(
      sampleTask({
        worktree_path: "/tmp/worktree",
        final_cleanup_state: "finished",
      }),
      false
    ),
    false
  );
});

test("shouldStartFinalCleanup skips tasks with active cleanup pids", () => {
  assert.equal(
    shouldStartFinalCleanup(
      sampleTask({
        worktree_path: "/tmp/worktree",
      }),
      true
    ),
    false
  );
});
