// In-process tests for the pure predicates that gate worker phases.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEAD_OWNED_PID_GRACE_MS,
  pollOnce,
  shouldFinalizeCleanupWorktree,
  shouldResetStaleFinalCleanup,
  shouldWaitForDeadOwnedPid,
  type WorkerRuntimeDeps,
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

test("shouldWaitForDeadOwnedPid only delays pids owned by this worker", () => {
  const task = sample({ id: "task-1", current_run_pid: 101 });
  const activePids = new Map([["task-1", 101]]);
  const deadOwnedPids = new Map();

  assert.equal(
    shouldWaitForDeadOwnedPid(task, activePids, deadOwnedPids, 1_000),
    true
  );
  assert.deepEqual(deadOwnedPids.get("task-1"), {
    pid: 101,
    firstSeenAt: 1_000,
  });
  assert.equal(
    shouldWaitForDeadOwnedPid(
      task,
      activePids,
      deadOwnedPids,
      1_000 + DEAD_OWNED_PID_GRACE_MS - 1
    ),
    true
  );
  assert.equal(
    shouldWaitForDeadOwnedPid(
      task,
      activePids,
      deadOwnedPids,
      1_000 + DEAD_OWNED_PID_GRACE_MS
    ),
    false
  );
  assert.equal(
    shouldWaitForDeadOwnedPid(task, new Map([["task-1", 202]]), new Map(), 1_000),
    false
  );
});

test("completion callbacks leave newer active pids in place", async () => {
  const tasks: Task[] = [
    sample({
      id: "task-1",
      status: "open",
      agent_runner: "codex",
      permission_mode: "bypassPermissions",
    }),
  ];
  const activePids = new Map<string, number>();
  const completions: Array<(taskId: string) => Promise<void> | void> = [];
  let nextPid = 101;

  const deps: WorkerRuntimeDeps = {
    deleteReviewSummary: async () => {},
    deleteTask: async () => {},
    getPRStateHash: async () => "",
    getPRStatus: async () => "unknown",
    getReviewRequestedPRs: async () => [],
    getTask: async (id) => tasks.find((task) => task.id === id),
    isPRMergedOrClosed: async () => null,
    isPidRunning: () => true,
    logger: { log: () => {}, error: () => {} },
    readConfig: () => ({
      max_parallel_sessions: 1,
      poll_interval_seconds: 30,
      default_permission_mode: "bypassPermissions",
      default_agent_runner: "codex",
      agents: {},
    }),
    readReviewLearnings: () => "",
    readReviewSummaries: () => [],
    readReviewSummaryMap: () => ({}),
    readTasks: () => tasks,
    removeWorktree: async () => {},
    spawnAgentSession: async (_task, _mode, onComplete) => {
      completions.push(onComplete);
      return { pid: nextPid++, child: {} as never };
    },
    spawnReviewRetro: async () => ({
      pid: 0,
      child: {} as never,
      done: Promise.resolve(),
    }),
    spawnReviewSummary: async () => ({
      pid: nextPid++,
      child: {} as never,
      done: Promise.resolve({} as never),
    }),
    updateTask: async (id, updates) => {
      const index = tasks.findIndex((task) => task.id === id);
      assert.notEqual(index, -1);
      tasks[index] = { ...tasks[index], ...updates };
      return tasks[index];
    },
    upsertReviewSummary: async (summary) => summary as never,
  };

  await pollOnce(activePids, deps, new Map());
  assert.equal(activePids.get("task-1"), 101);
  assert.equal(completions.length, 1);

  activePids.set("task-1", 202);
  await completions[0]("task-1");

  assert.equal(activePids.get("task-1"), 202);
});

test("pollOnce gives dead owned pids a grace window before resuming", async () => {
  const tasks: Task[] = [
    sample({
      id: "task-1",
      status: "open",
      current_run_pid: 101,
      session_id: "thread-1",
      agent_runner: "codex",
      permission_mode: "bypassPermissions",
    }),
  ];
  const activePids = new Map([["task-1", 101]]);
  const deadOwnedPids = new Map<string, { pid: number; firstSeenAt: number }>();
  const updates: Partial<Task>[] = [];
  const deps: WorkerRuntimeDeps = {
    deleteReviewSummary: async () => {},
    deleteTask: async () => {},
    getPRStateHash: async () => "",
    getPRStatus: async () => "unknown",
    getReviewRequestedPRs: async () => [],
    getTask: async (id) => tasks.find((task) => task.id === id),
    isPRMergedOrClosed: async () => null,
    isPidRunning: () => false,
    logger: { log: () => {}, error: () => {} },
    readConfig: () => ({
      max_parallel_sessions: 0,
      poll_interval_seconds: 30,
      default_permission_mode: "bypassPermissions",
      default_agent_runner: "codex",
      agents: {},
    }),
    readReviewLearnings: () => "",
    readReviewSummaries: () => [],
    readReviewSummaryMap: () => ({}),
    readTasks: () => tasks,
    removeWorktree: async () => {},
    spawnAgentSession: async () => ({ pid: 202, child: {} as never }),
    spawnReviewRetro: async () => ({
      pid: 0,
      child: {} as never,
      done: Promise.resolve(),
    }),
    spawnReviewSummary: async () => ({
      pid: 303,
      child: {} as never,
      done: Promise.resolve({} as never),
    }),
    updateTask: async (id, updatesForTask) => {
      const index = tasks.findIndex((task) => task.id === id);
      assert.notEqual(index, -1);
      updates.push(updatesForTask);
      tasks[index] = { ...tasks[index], ...updatesForTask };
      return tasks[index];
    },
    upsertReviewSummary: async (summary) => summary as never,
  };

  await pollOnce(activePids, deps, new Map(), deadOwnedPids);
  assert.equal(activePids.get("task-1"), 101);
  assert.equal(tasks[0].current_run_pid, 101);
  assert.equal(tasks[0].resume_requested, undefined);
  assert.equal(updates.length, 0);

  deadOwnedPids.set("task-1", {
    pid: 101,
    firstSeenAt: Date.now() - DEAD_OWNED_PID_GRACE_MS,
  });
  await pollOnce(activePids, deps, new Map(), deadOwnedPids);
  assert.equal(activePids.has("task-1"), false);
  assert.equal(tasks[0].current_run_pid, undefined);
  assert.equal(tasks[0].resume_requested, true);
});

test("pollOnce rechecks latest review hash before launching review run", async () => {
  const staleTask = sample({
    id: "task-1",
    status: "in_review",
    pr_url: "https://github.com/acme/widget/pull/1",
    last_review_gh_state: "old-hash",
    agent_runner: "codex",
    permission_mode: "bypassPermissions",
  });
  const latestTask = {
    ...staleTask,
    last_review_gh_state: "new-hash",
  };
  const spawnedTasks: Task[] = [];
  const deps: WorkerRuntimeDeps = {
    deleteReviewSummary: async () => {},
    deleteTask: async () => {},
    getPRStateHash: async () => "new-hash",
    getPRStatus: async () => "unknown",
    getReviewRequestedPRs: async () => [],
    getTask: async (id) => (id === latestTask.id ? latestTask : undefined),
    isPRMergedOrClosed: async () => null,
    isPidRunning: () => true,
    logger: { log: () => {}, error: () => {} },
    readConfig: () => ({
      max_parallel_sessions: 1,
      poll_interval_seconds: 30,
      default_permission_mode: "bypassPermissions",
      default_agent_runner: "codex",
      agents: {},
    }),
    readReviewLearnings: () => "",
    readReviewSummaries: () => [],
    readReviewSummaryMap: () => ({}),
    readTasks: () => [staleTask],
    removeWorktree: async () => {},
    spawnAgentSession: async (task) => {
      spawnedTasks.push(task);
      return { pid: 202, child: {} as never };
    },
    spawnReviewRetro: async () => ({
      pid: 0,
      child: {} as never,
      done: Promise.resolve(),
    }),
    spawnReviewSummary: async () => ({
      pid: 303,
      child: {} as never,
      done: Promise.resolve({} as never),
    }),
    updateTask: async (_id, updates) => ({ ...latestTask, ...updates }),
    upsertReviewSummary: async (summary) => summary as never,
  };

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(spawnedTasks, []);
});

test("pollOnce launches a pending reviewer run before feedback handling", async () => {
  const tasks: Task[] = [
    sample({
      id: "task-1",
      status: "in_review",
      pr_url: "https://github.com/acme/widget/pull/1",
      pending_manual_instruction: "apply this after review",
      reviewer_run_pending: true,
      agent_runner: "codex",
      permission_mode: "bypassPermissions",
    }),
  ];
  const launchedModes: string[] = [];
  const spawnedManualInstructions: Array<string | undefined> = [];
  let hashCalls = 0;
  const deps: WorkerRuntimeDeps = {
    deleteReviewSummary: async () => {},
    deleteTask: async () => {},
    getPRStateHash: async () => {
      hashCalls++;
      return "new-hash";
    },
    getPRStatus: async () => "checks_pending",
    getReviewRequestedPRs: async () => [],
    getTask: async (id) => tasks.find((task) => task.id === id),
    isPRMergedOrClosed: async () => null,
    isPidRunning: () => true,
    logger: { log: () => {}, error: () => {} },
    readConfig: () => ({
      max_parallel_sessions: 1,
      poll_interval_seconds: 30,
      default_permission_mode: "bypassPermissions",
      default_agent_runner: "codex",
      agents: {},
    }),
    readReviewLearnings: () => "",
    readReviewSummaries: () => [],
    readReviewSummaryMap: () => ({}),
    readTasks: () => tasks,
    removeWorktree: async () => {},
    spawnAgentSession: async (task, mode) => {
      spawnedManualInstructions.push(task.pending_manual_instruction);
      launchedModes.push(mode);
      return { pid: 202, child: {} as never };
    },
    spawnReviewRetro: async () => ({
      pid: 0,
      child: {} as never,
      done: Promise.resolve(),
    }),
    spawnReviewSummary: async () => ({
      pid: 303,
      child: {} as never,
      done: Promise.resolve({} as never),
    }),
    updateTask: async (id, updates) => {
      const index = tasks.findIndex((task) => task.id === id);
      assert.notEqual(index, -1);
      tasks[index] = { ...tasks[index], ...updates };
      return tasks[index];
    },
    upsertReviewSummary: async (summary) => summary as never,
  };

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(launchedModes, ["reviewer"]);
  assert.deepEqual(spawnedManualInstructions, [undefined]);
  assert.equal(hashCalls, 0);
  assert.equal(tasks[0].reviewer_run_pending, false);
  assert.equal(tasks[0].pending_manual_instruction, "apply this after review");
  assert.equal(tasks[0].current_run_mode, "reviewer");
});

test("pollOnce skips paused open tasks", async () => {
  const tasks: Task[] = [
    sample({
      id: "task-1",
      status: "open",
      paused: true,
      agent_runner: "codex",
      permission_mode: "bypassPermissions",
    }),
  ];
  const launchedModes: string[] = [];
  const deps: WorkerRuntimeDeps = {
    deleteReviewSummary: async () => {},
    deleteTask: async () => {},
    getPRStateHash: async () => "",
    getPRStatus: async () => "unknown",
    getReviewRequestedPRs: async () => [],
    getTask: async (id) => tasks.find((task) => task.id === id),
    isPRMergedOrClosed: async () => null,
    isPidRunning: () => true,
    logger: { log: () => {}, error: () => {} },
    readConfig: () => ({
      max_parallel_sessions: 1,
      poll_interval_seconds: 30,
      default_permission_mode: "bypassPermissions",
      default_agent_runner: "codex",
      agents: {},
    }),
    readReviewLearnings: () => "",
    readReviewSummaries: () => [],
    readReviewSummaryMap: () => ({}),
    readTasks: () => tasks,
    removeWorktree: async () => {},
    spawnAgentSession: async (_task, mode) => {
      launchedModes.push(mode);
      return { pid: 202, child: {} as never };
    },
    spawnReviewRetro: async () => ({
      pid: 0,
      child: {} as never,
      done: Promise.resolve(),
    }),
    spawnReviewSummary: async () => ({
      pid: 303,
      child: {} as never,
      done: Promise.resolve({} as never),
    }),
    updateTask: async (id, updates) => {
      const index = tasks.findIndex((task) => task.id === id);
      assert.notEqual(index, -1);
      tasks[index] = { ...tasks[index], ...updates };
      return tasks[index];
    },
    upsertReviewSummary: async (summary) => summary as never,
  };

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(launchedModes, []);
  assert.equal(tasks[0].status, "open");
});

test("pollOnce skips paused in_review tasks entirely", async () => {
  const tasks: Task[] = [
    sample({
      id: "task-1",
      status: "in_review",
      paused: true,
      pr_url: "https://github.com/acme/widget/pull/1",
      reviewer_run_pending: true,
      agent_runner: "codex",
      permission_mode: "bypassPermissions",
    }),
  ];
  const launchedModes: string[] = [];
  let prStateChecks = 0;
  const deps: WorkerRuntimeDeps = {
    deleteReviewSummary: async () => {},
    deleteTask: async () => {},
    getPRStateHash: async () => "new-hash",
    getPRStatus: async () => "clean",
    getReviewRequestedPRs: async () => [],
    getTask: async (id) => tasks.find((task) => task.id === id),
    isPRMergedOrClosed: async () => {
      prStateChecks++;
      return null;
    },
    isPidRunning: () => true,
    logger: { log: () => {}, error: () => {} },
    readConfig: () => ({
      max_parallel_sessions: 1,
      poll_interval_seconds: 30,
      default_permission_mode: "bypassPermissions",
      default_agent_runner: "codex",
      agents: {},
    }),
    readReviewLearnings: () => "",
    readReviewSummaries: () => [],
    readReviewSummaryMap: () => ({}),
    readTasks: () => tasks,
    removeWorktree: async () => {},
    spawnAgentSession: async (_task, mode) => {
      launchedModes.push(mode);
      return { pid: 202, child: {} as never };
    },
    spawnReviewRetro: async () => ({
      pid: 0,
      child: {} as never,
      done: Promise.resolve(),
    }),
    spawnReviewSummary: async () => ({
      pid: 303,
      child: {} as never,
      done: Promise.resolve({} as never),
    }),
    updateTask: async (id, updates) => {
      const index = tasks.findIndex((task) => task.id === id);
      assert.notEqual(index, -1);
      tasks[index] = { ...tasks[index], ...updates };
      return tasks[index];
    },
    upsertReviewSummary: async (summary) => summary as never,
  };

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(launchedModes, []);
  assert.equal(prStateChecks, 0);
  assert.equal(tasks[0].reviewer_run_pending, true);
});

test("pollOnce skips pending reviewer runs when reviewer agent is disabled", async () => {
  const tasks: Task[] = [
    sample({
      id: "task-1",
      status: "in_review",
      pr_url: "https://github.com/acme/widget/pull/1",
      reviewer_agent_enabled: false,
      reviewer_run_pending: true,
      last_review_gh_state: "same-hash",
      agent_runner: "codex",
      permission_mode: "bypassPermissions",
    }),
  ];
  const launchedModes: string[] = [];
  let hashCalls = 0;
  const deps: WorkerRuntimeDeps = {
    deleteReviewSummary: async () => {},
    deleteTask: async () => {},
    getPRStateHash: async () => {
      hashCalls++;
      return "same-hash";
    },
    getPRStatus: async () => "clean",
    getReviewRequestedPRs: async () => [],
    getTask: async (id) => tasks.find((task) => task.id === id),
    isPRMergedOrClosed: async () => null,
    isPidRunning: () => true,
    logger: { log: () => {}, error: () => {} },
    readConfig: () => ({
      max_parallel_sessions: 1,
      poll_interval_seconds: 30,
      default_permission_mode: "bypassPermissions",
      default_agent_runner: "codex",
      agents: {},
    }),
    readReviewLearnings: () => "",
    readReviewSummaries: () => [],
    readReviewSummaryMap: () => ({}),
    readTasks: () => tasks,
    removeWorktree: async () => {},
    spawnAgentSession: async (_task, mode) => {
      launchedModes.push(mode);
      return { pid: 202, child: {} as never };
    },
    spawnReviewRetro: async () => ({
      pid: 0,
      child: {} as never,
      done: Promise.resolve(),
    }),
    spawnReviewSummary: async () => ({
      pid: 303,
      child: {} as never,
      done: Promise.resolve({} as never),
    }),
    updateTask: async (id, updates) => {
      const index = tasks.findIndex((task) => task.id === id);
      assert.notEqual(index, -1);
      tasks[index] = { ...tasks[index], ...updates };
      return tasks[index];
    },
    upsertReviewSummary: async (summary) => summary as never,
  };

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(launchedModes, []);
  assert.equal(hashCalls, 1);
  assert.equal(tasks[0].reviewer_run_pending, true);
  assert.equal(tasks[0].current_run_mode, undefined);
});
