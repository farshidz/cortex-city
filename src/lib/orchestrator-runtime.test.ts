import test from "node:test";
import assert from "node:assert/strict";

import type { Task } from "./types";
import {
  buildInterruptedTaskUpdates,
  getTaskRunMode,
  shouldResumeTask,
  shouldUseContinuePrompt,
} from "./orchestrator-runtime";

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Investigate recovery flow",
    description: "Keep interrupted tasks recoverable across worker restarts",
    status: "in_progress",
    agent: "cortex-city-swe",
    created_at: "2026-04-15T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

test("buildInterruptedTaskUpdates marks active work for resume", () => {
  const updates = buildInterruptedTaskUpdates(
    sampleTask({
      status: "in_review",
      current_run_pid: 12345,
    })
  );

  assert.deepEqual(updates, {
    current_run_pid: undefined,
    resume_requested: true,
  });
});

test("buildInterruptedTaskUpdates only clears pid for final tasks", () => {
  const updates = buildInterruptedTaskUpdates(
    sampleTask({
      status: "merged",
      current_run_pid: 12345,
    })
  );

  assert.deepEqual(updates, {
    current_run_pid: undefined,
  });
});

test("shouldResumeTask accepts interrupted review runs and manual instructions", () => {
  assert.equal(
    shouldResumeTask(
      sampleTask({
        status: "in_review",
        current_run_pid: undefined,
        resume_requested: true,
      })
    ),
    true
  );

  assert.equal(
    shouldResumeTask(
      sampleTask({
        status: "open",
        current_run_pid: undefined,
        pending_manual_instruction: "Apply reviewer notes",
      })
    ),
    true
  );
});

test("getTaskRunMode uses review mode only for in_review tasks", () => {
  assert.equal(getTaskRunMode(sampleTask({ status: "in_review" })), "review");
  assert.equal(getTaskRunMode(sampleTask({ status: "open" })), "initial");
});

test("shouldUseContinuePrompt requires an existing session", () => {
  assert.equal(
    shouldUseContinuePrompt(
      sampleTask({
        resume_requested: true,
        session_id: "thread-123",
      })
    ),
    true
  );

  assert.equal(
    shouldUseContinuePrompt(
      sampleTask({
        resume_requested: true,
        session_id: undefined,
      })
    ),
    false
  );
});
