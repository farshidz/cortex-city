import test from "node:test";
import assert from "node:assert/strict";
import { getTaskTableRows } from "./task-hierarchy";
import type { Task } from "./types";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "task",
    title: "Task",
    description: "Description",
    status: "open",
    agent: "cortex-city-swe",
    created_at: "2026-05-28T00:00:00.000Z",
    updated_at: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

test("task table rows place child tasks directly under their parent", () => {
  const rows = getTaskTableRows([
    makeTask({ id: "standalone", title: "Standalone" }),
    makeTask({
      id: "child-newer",
      title: "Child newer",
      parent_task_id: "parent",
    }),
    makeTask({ id: "parent", title: "Parent" }),
    makeTask({
      id: "grandchild",
      title: "Grandchild",
      parent_task_id: "child-newer",
    }),
    makeTask({
      id: "child-older",
      title: "Child older",
      parent_task_id: "parent",
    }),
  ]);

  assert.deepEqual(
    rows.map(({ task, depth }) => ({ id: task.id, depth })),
    [
      { id: "standalone", depth: 0 },
      { id: "parent", depth: 0 },
      { id: "child-newer", depth: 1 },
      { id: "grandchild", depth: 2 },
      { id: "child-older", depth: 1 },
    ]
  );
});

test("task table rows keep orphaned child tasks visible as root rows", () => {
  const rows = getTaskTableRows([
    makeTask({
      id: "orphaned-child",
      title: "Orphaned child",
      parent_task_id: "missing-parent",
    }),
  ]);

  assert.deepEqual(
    rows.map(({ task, depth }) => ({ id: task.id, depth })),
    [{ id: "orphaned-child", depth: 0 }]
  );
});
