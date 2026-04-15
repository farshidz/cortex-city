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

test("worker can run codex and claude tasks in parallel without sharing worktrees", async (t) => {
  const workspace = createIntegrationWorkspace("cortex-parallel-", {
    maxParallelSessions: 2,
  });

  writeBehavior(workspace, [
    {
      runtime: "codex",
      match: "Codex parallel task",
      delay_ms: 400,
      thread_id: "thread-codex",
      usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 3 },
      report: report({
        summary: "Codex run finished",
        branch_name: "agent/codex-parallel",
      }),
    },
    {
      runtime: "claude",
      match: "Claude parallel task",
      delay_ms: 400,
      thread_id: "thread-claude",
      usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 4 },
      report: report({
        summary: "Claude run finished",
        branch_name: "agent/claude-parallel",
      }),
    },
  ]);

  writeTasks(workspace, [
    createTask({
      id: "codex-task",
      title: "Codex parallel task",
      description: "Exercise the Codex runtime",
      plan: "Run beside Claude",
      agent_runner: "codex",
    }),
    createTask({
      id: "claude-task",
      title: "Claude parallel task",
      description: "Exercise the Claude runtime",
      plan: "Run beside Codex",
      agent_runner: "claude",
    }),
  ]);

  const worker = spawnWorker(workspace);
  t.after(async () => {
    await stopWorker(worker);
    removeWorkspace(workspace);
  });

  await waitFor("both tasks to start in parallel", () => {
    const currentTasks = readTasks(workspace);
    const codexTask = currentTasks.find((task) => task.id === "codex-task");
    const claudeTask = currentTasks.find((task) => task.id === "claude-task");

    if (!codexTask?.current_run_pid || !claudeTask?.current_run_pid) {
      return undefined;
    }

    return { codexTask, claudeTask };
  });

  const tasks = await waitFor("both tasks to complete one run", () => {
    const currentTasks = readTasks(workspace);
    const codexTask = currentTasks.find((task) => task.id === "codex-task");
    const claudeTask = currentTasks.find((task) => task.id === "claude-task");

    if (!codexTask || !claudeTask) return undefined;
    if (codexTask.run_count !== 1 || claudeTask.run_count !== 1) return undefined;
    if (codexTask.current_run_pid || claudeTask.current_run_pid) return undefined;

    return { codexTask, claudeTask };
  });

  assert.equal(tasks.codexTask.session_id, "thread-codex");
  assert.equal(tasks.claudeTask.session_id, "thread-claude");
  assert.equal(tasks.codexTask.total_input_tokens, 7);
  assert.equal(tasks.claudeTask.total_input_tokens, 7);
  assert.equal(tasks.codexTask.total_output_tokens, 3);
  assert.equal(tasks.claudeTask.total_output_tokens, 4);

  assert.ok(tasks.codexTask.worktree_path);
  assert.ok(tasks.claudeTask.worktree_path);
  assert.notEqual(tasks.codexTask.worktree_path, tasks.claudeTask.worktree_path);

  const codexRunLog = path.join(tasks.codexTask.worktree_path!, ".fake-agent-last-run.json");
  const claudeRunLog = path.join(tasks.claudeTask.worktree_path!, ".fake-agent-last-run.json");
  assert.ok(existsSync(codexRunLog));
  assert.ok(existsSync(claudeRunLog));

  const codexRun = JSON.parse(readFileSync(codexRunLog, "utf-8")) as { runtime: string; prompt: string };
  const claudeRun = JSON.parse(readFileSync(claudeRunLog, "utf-8")) as { runtime: string; prompt: string };

  assert.equal(codexRun.runtime, "codex");
  assert.equal(claudeRun.runtime, "claude");
  assert.match(codexRun.prompt, /Codex parallel task/);
  assert.match(claudeRun.prompt, /Claude parallel task/);
});
