import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

import type { AgentReport } from "../lib/types";
import {
  createIntegrationWorkspace,
  createTask,
  readTasks,
  removeWorkspace,
  spawnWorker,
  stopWorker,
  waitFor,
  writeBehavior,
  writeTasks,
} from "./test-helpers";

function report(overrides: Partial<AgentReport> = {}): AgentReport {
  return {
    status: "completed",
    summary: "Completed integration run",
    pr_url: "",
    branch_name: "agent/integration",
    files_changed: [],
    assumptions: [],
    blockers: [],
    next_steps: [],
    ...overrides,
  };
}

test("worker creates and executes a follow-up task from a Cortex tool call", async (t) => {
  const workspace = createIntegrationWorkspace("cortex-followup-", {
    maxParallelSessions: 1,
  });

  writeBehavior(workspace, [
    {
      runtime: "codex",
      match: "Parent integration task",
      thread_id: "thread-parent",
      report: report({
        summary: "Created the follow-up task",
        branch_name: "agent/parent",
        tool_calls: {
          create_task: [
            {
              title: "Child integration task",
              description: "Run the delegated follow-up",
              agent: "cortex-city-swe",
              plan: "Verify the downstream workflow",
            },
          ],
        },
      }),
    },
    {
      runtime: "codex",
      match: "Child integration task",
      thread_id: "thread-child",
      report: report({
        summary: "Child task completed",
        branch_name: "agent/child",
      }),
    },
  ]);

  writeTasks(workspace, [
    createTask({
      id: "parent-task",
      title: "Parent integration task",
      description: "Create a follow-up task through Cortex",
      plan: "Delegate the next step",
    }),
  ]);

  const worker = spawnWorker(workspace);
  t.after(async () => {
    await stopWorker(worker);
    removeWorkspace(workspace);
  });

  const tasks = await waitFor("parent and child tasks to finish one run", () => {
    const currentTasks = readTasks(workspace);
    if (currentTasks.length !== 2) return undefined;

    const parentTask = currentTasks.find((task) => task.id === "parent-task");
    const childTask = currentTasks.find((task) => task.parent_task_id === "parent-task");

    if (!parentTask || !childTask) return undefined;
    if (parentTask.run_count !== 1 || childTask.run_count !== 1) return undefined;
    if (parentTask.session_id !== "thread-parent") return undefined;
    if (childTask.session_id !== "thread-child") return undefined;

    return { parentTask, childTask };
  });

  assert.equal(tasks.parentTask.last_agent_report?.tool_calls?.create_task?.length, 1);
  assert.equal(tasks.childTask.title, "Child integration task");
  assert.equal(tasks.childTask.description, "Run the delegated follow-up");
  assert.equal(tasks.childTask.plan, "Verify the downstream workflow");
  assert.equal(tasks.childTask.agent_runner, "codex");
  assert.equal(tasks.childTask.permission_mode, "bypassPermissions");
  assert.equal(tasks.childTask.status, "in_progress");

  assert.notEqual(tasks.parentTask.worktree_path, tasks.childTask.worktree_path);
  assert.ok(tasks.parentTask.worktree_path);
  assert.ok(tasks.childTask.worktree_path);

  const parentRunLog = path.join(tasks.parentTask.worktree_path!, ".fake-agent-last-run.json");
  const childRunLog = path.join(tasks.childTask.worktree_path!, ".fake-agent-last-run.json");
  assert.ok(existsSync(parentRunLog));
  assert.ok(existsSync(childRunLog));

  const parentRun = JSON.parse(readFileSync(parentRunLog, "utf-8")) as { prompt: string };
  const childRun = JSON.parse(readFileSync(childRunLog, "utf-8")) as { prompt: string };
  assert.match(parentRun.prompt, /Parent integration task/);
  assert.match(childRun.prompt, /Child integration task/);
});
