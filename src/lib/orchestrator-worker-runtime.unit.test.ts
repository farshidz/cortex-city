// In-process tests for the pure predicates that gate worker phases.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEAD_OWNED_PID_GRACE_MS,
  pollOnce,
  shouldFinalizeCleanupWorktree,
  shouldResetStaleFinalCleanup,
  shouldWaitForDeadOwnedPid,
  type WorkerRuntimeDeps,
} from "./orchestrator-worker-runtime";
import type { ReviewSummary, Task, TaskStackedPR } from "./types";

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

function makeFinalCleanupHarness(
  task: Task,
  removeWorktree: WorkerRuntimeDeps["removeWorktree"]
) {
  const tasks = [task];
  const completions: Array<(taskId: string) => Promise<void> | void> = [];
  const deps: WorkerRuntimeDeps = {
    deleteReviewSummary: async () => {},
    deleteTask: async () => {},
    getPRStateHash: async () => "",
    getPRStatus: async () => "unknown",
    getReviewRequestedPRs: async () => [],
    getTask: async (id) => tasks.find((candidate) => candidate.id === id),
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
    readTasks: () => tasks.map((candidate) => ({ ...candidate })),
    removeWorktree,
    removeFinalReviewWorkspace: async () => true,
    spawnAgentSession: async (_task, _mode, onComplete) => {
      completions.push(onComplete);
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
      const index = tasks.findIndex((candidate) => candidate.id === id);
      assert.notEqual(index, -1);
      tasks[index] = { ...tasks[index], ...updates };
      return tasks[index];
    },
    upsertReviewSummary: async (summary) => summary as never,
  };
  return { completions, deps, tasks };
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
      sample({
        final_cleanup_state: "running",
        current_run_pid: 123,
        worktree_path: "/tmp/x",
      }),
      false
    ),
    false
  );
  assert.equal(
    shouldResetStaleFinalCleanup(
      sample({ final_cleanup_state: "running", current_run_pid: 123 }),
      false
    ),
    true
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

test("cleanup completion retains the worktree path after removal failure and retries", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "worker-cleanup-retry-"));
  const worktreePath = path.join(workspace, "worktree");
  mkdirSync(worktreePath);
  let removalSucceeds = false;
  let removalAttempts = 0;
  const { completions, deps, tasks } = makeFinalCleanupHarness(
    sample({
      id: "cleanup-retry",
      worktree_path: worktreePath,
      updated_at: new Date().toISOString(),
    }),
    async (task) => {
      removalAttempts++;
      if (removalSucceeds && task.worktree_path) {
        rmSync(task.worktree_path, { recursive: true, force: true });
      }
    }
  );
  const activePids = new Map<string, number>();

  await pollOnce(activePids, deps, new Map());
  assert.equal(completions.length, 1);
  await completions[0]("cleanup-retry");

  assert.equal(removalAttempts, 1);
  assert.equal(tasks[0].final_cleanup_state, "finished");
  assert.equal(tasks[0].worktree_path, worktreePath);

  removalSucceeds = true;
  await pollOnce(activePids, deps, new Map());

  assert.equal(removalAttempts, 2);
  assert.equal(tasks[0].worktree_path, undefined);
});

test("finished cleanup retains the worktree path after removal failure and retries", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "worker-finished-retry-"));
  const worktreePath = path.join(workspace, "worktree");
  mkdirSync(worktreePath);
  let removalSucceeds = false;
  let removalAttempts = 0;
  const { deps, tasks } = makeFinalCleanupHarness(
    sample({
      id: "finished-retry",
      final_cleanup_state: "finished",
      worktree_path: worktreePath,
      updated_at: new Date().toISOString(),
    }),
    async (task) => {
      removalAttempts++;
      if (removalSucceeds && task.worktree_path) {
        rmSync(task.worktree_path, { recursive: true, force: true });
      }
    }
  );

  await pollOnce(new Map(), deps, new Map());
  assert.equal(removalAttempts, 1);
  assert.equal(tasks[0].worktree_path, worktreePath);

  removalSucceeds = true;
  await pollOnce(new Map(), deps, new Map());

  assert.equal(removalAttempts, 2);
  assert.equal(tasks[0].worktree_path, undefined);
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
    removeFinalReviewWorkspace: async () => true,
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
    removeFinalReviewWorkspace: async () => true,
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

test("pollOnce clears missing final worktree paths without launching cleanup and prunes old tasks", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "worker-missing-final-"));
  const missingWorktree = path.join(workspace, "missing-worktree");
  const missingRunningWorktree = path.join(workspace, "missing-running-worktree");
  const tasks: Task[] = [
    sample({
      id: "missing-final",
      status: "merged",
      worktree_path: missingWorktree,
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
    sample({
      id: "missing-running-final",
      status: "closed",
      worktree_path: missingRunningWorktree,
      final_cleanup_state: "running",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
  ];
  const deletedTaskIds: string[] = [];
  let cleanupLaunches = 0;
  let worktreeRemovals = 0;

  const deps: WorkerRuntimeDeps = {
    deleteReviewSummary: async () => {},
    deleteTask: async (id) => {
      deletedTaskIds.push(id);
      const index = tasks.findIndex((task) => task.id === id);
      assert.notEqual(index, -1);
      tasks.splice(index, 1);
    },
    getPRStateHash: async () => "",
    getPRStatus: async () => "unknown",
    getReviewRequestedPRs: async () => [],
    getTask: async (id) => tasks.find((task) => task.id === id),
    isPRMergedOrClosed: async () => null,
    isPidRunning: () => true,
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
    readTasks: () => tasks.map((task) => ({ ...task })),
    removeWorktree: async () => {
      worktreeRemovals++;
    },
    removeFinalReviewWorkspace: async () => true,
    spawnAgentSession: async () => {
      cleanupLaunches++;
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
    updateTask: async (id, updatesForTask) => {
      const index = tasks.findIndex((task) => task.id === id);
      assert.notEqual(index, -1);
      tasks[index] = {
        ...tasks[index],
        ...updatesForTask,
        updated_at: new Date().toISOString(),
      };
      return tasks[index];
    },
    upsertReviewSummary: async (summary) => summary as never,
  };

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(deletedTaskIds.sort(), [
    "missing-final",
    "missing-running-final",
  ]);
  assert.equal(cleanupLaunches, 0);
  assert.equal(worktreeRemovals, 0);
  assert.deepEqual(tasks, []);
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
    removeFinalReviewWorkspace: async () => true,
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
    removeFinalReviewWorkspace: async () => true,
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
    removeFinalReviewWorkspace: async () => true,
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
});

const STACK_PR_1 = "https://github.com/acme/widget/pull/1";
const STACK_PR_2 = "https://github.com/acme/widget/pull/2";
const STACK_PR_3 = "https://github.com/acme/widget/pull/3";

function stackEntry(overrides: Partial<TaskStackedPR> = {}): TaskStackedPR {
  return {
    position: 1,
    pr_url: STACK_PR_1,
    branch_name: "b1",
    base_branch: "main",
    scope: "Slice one",
    state: "open",
    ...overrides,
  };
}

interface StackedDepsOptions {
  tasks: Task[];
  mergedOrClosed?: Record<string, "merged" | "closed" | null>;
  prStatuses?: Record<string, Awaited<ReturnType<WorkerRuntimeDeps["getPRStatus"]>>>;
  headShas?: Record<string, string>;
  stateHashes?: Record<string, string>;
  baseBranches?: Record<string, string>;
  mergeCommitShas?: Record<string, string>;
  // Keyed as "<ancestor>...<descendant>".
  ancestors?: Record<string, boolean | null>;
  reviewMap?: Record<string, ReviewSummary>;
}

function makeStackedDeps(options: StackedDepsOptions) {
  const tasks = options.tasks;
  const launched: Array<{ taskId: string; mode: string }> = [];
  const upserted: ReviewSummary[] = [];
  const reviewMap: Record<string, ReviewSummary> = {
    ...(options.reviewMap || {}),
  };
  const deps: WorkerRuntimeDeps = {
    deleteReviewSummary: async () => {},
    deleteTask: async () => {},
    getPRBaseBranch: async (prUrl) => options.baseBranches?.[prUrl] || "",
    getPRHeadSha: async (prUrl) => options.headShas?.[prUrl] || "",
    getPRMergeCommitSha: async (prUrl) => options.mergeCommitShas?.[prUrl] ?? "",
    getPRStateHash: async (prUrl) => options.stateHashes?.[prUrl] || "",
    isCommitAncestor: async (_repoSlug, ancestorSha, descendantSha) =>
      options.ancestors?.[`${ancestorSha}...${descendantSha}`] ?? null,
    getPRStatus: async (prUrl) => options.prStatuses?.[prUrl] || "unknown",
    getReviewRequestedPRs: async () => [],
    getTask: async (id) => tasks.find((task) => task.id === id),
    isPRMergedOrClosed: async (prUrl) => options.mergedOrClosed?.[prUrl] || null,
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
    readReviewSummaries: () => Object.values(reviewMap),
    readReviewSummaryMap: () => ({ ...reviewMap }),
    readTasks: () => tasks,
    removeWorktree: async () => {},
    removeFinalReviewWorkspace: async () => true,
    spawnAgentSession: async (task, mode) => {
      launched.push({ taskId: task.id, mode });
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
      done: new Promise(() => {}),
    }),
    updateTask: async (id, updates) => {
      const index = tasks.findIndex((task) => task.id === id);
      assert.notEqual(index, -1);
      tasks[index] = { ...tasks[index], ...updates };
      return tasks[index];
    },
    upsertReviewSummary: async (summary) => {
      upserted.push(summary as ReviewSummary);
      reviewMap[summary.pr_url] = summary as ReviewSummary;
      return summary as ReviewSummary;
    },
  };
  return { deps, launched, upserted, tasks };
}

test("pollOnce marks a stacked task merged only when every entry merged", async () => {
  const { deps, launched, tasks } = makeStackedDeps({
    tasks: [
      sample({
        id: "task-1",
        status: "in_review",
        pr_url: STACK_PR_2,
        stacked_prs: [
          stackEntry({ state: "merged" }),
          stackEntry({
            position: 2,
            pr_url: STACK_PR_2,
            branch_name: "b2",
            base_branch: "b1",
            scope: "Slice two",
          }),
        ],
      }),
    ],
    mergedOrClosed: { [STACK_PR_2]: "merged" },
    mergeCommitShas: { [STACK_PR_2]: "squash-2" },
  });

  await pollOnce(new Map(), deps, new Map());

  assert.equal(tasks[0].status, "merged");
  assert.equal(tasks[0].pr_status, undefined);
  assert.deepEqual(
    tasks[0].stacked_prs?.map((entry) => entry.state),
    ["merged", "merged"]
  );
  assert.deepEqual(launched, []);
});

test("pollOnce closes a stacked task when an entry closed without merging", async () => {
  const { deps, tasks } = makeStackedDeps({
    tasks: [
      sample({
        id: "task-1",
        status: "in_review",
        pr_url: STACK_PR_2,
        stacked_prs: [
          stackEntry({ state: "merged" }),
          stackEntry({
            position: 2,
            pr_url: STACK_PR_2,
            branch_name: "b2",
            base_branch: "b1",
          }),
        ],
      }),
    ],
    mergedOrClosed: { [STACK_PR_2]: "closed" },
  });

  await pollOnce(new Map(), deps, new Map());

  assert.equal(tasks[0].status, "closed");
});

test("pollOnce launches a restack review run when a lower stack PR merges", async () => {
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_1,
    branch_name: "b1",
    agent_runner: "codex",
    permission_mode: "bypassPermissions",
    stacked_prs: [
      stackEntry(),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        // The hash matches the poll result, so only the restack forces a run.
        last_review_gh_state: "hash-2",
      }),
    ],
  });
  const currentReview: ReviewSummary = {
    source: "task",
    task_id: "task-1",
    task_title: "t",
    task_description: "",
    task_plan: undefined,
    task_stack_position: 2,
    task_stack_size: 2,
    task_pr_scope: "Slice two",
    pr_url: STACK_PR_2,
    pr_number: 2,
    repo_slug: "acme/widget",
    title: "t (stack 2/2)",
    author: "",
    head_sha: "head-2",
    created_at: "",
    updated_at: "",
    summary: "Reviewed and fine",
    summary_head_sha: "head-2",
    generated_at: "2026-05-01T00:00:00.000Z",
    review_status: "up_to_date",
    review_state: "reviewed",
  };
  const { deps, launched, tasks } = makeStackedDeps({
    tasks: [task],
    mergedOrClosed: { [STACK_PR_1]: "merged" },
    mergeCommitShas: { [STACK_PR_1]: "squash-1" },
    prStatuses: { [STACK_PR_2]: "clean" },
    headShas: { [STACK_PR_2]: "head-2" },
    stateHashes: { [STACK_PR_2]: "hash-2" },
    reviewMap: { [STACK_PR_2]: currentReview },
  });

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(launched, [{ taskId: "task-1", mode: "review" }]);
  assert.equal(tasks[0].stacked_prs?.[0].state, "merged");
  // The mirror follows the new frontier entry.
  assert.equal(tasks[0].pr_url, STACK_PR_2);
  assert.equal(tasks[0].branch_name, "b2");
  assert.equal(tasks[0].pr_status, "clean");
  assert.equal(tasks[0].current_run_mode, "review");
});

test("pollOnce keeps forcing restack when GitHub still reports the old base", async () => {
  // The agent's report claimed PR 2 was retargeted to main, but the actual
  // gh pr edit failed: GitHub still says the base is b1. The poll must
  // correct the recorded base from GitHub and keep forcing the restack run.
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_2,
    branch_name: "b2",
    stacked_prs: [
      stackEntry({ state: "merged" }),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "main", // stale claim from the agent report
        scope: "Slice two",
        last_review_gh_state: "hash-2",
      }),
    ],
  });
  const currentReview: ReviewSummary = {
    source: "task",
    task_id: "task-1",
    task_title: "t",
    task_description: "",
    task_plan: undefined,
    task_stack_position: 2,
    task_stack_size: 2,
    task_pr_scope: "Slice two",
    pr_url: STACK_PR_2,
    pr_number: 2,
    repo_slug: "acme/widget",
    title: "t (stack 2/2)",
    author: "",
    head_sha: "head-2",
    created_at: "",
    updated_at: "",
    summary: "Reviewed and fine",
    summary_head_sha: "head-2",
    generated_at: "2026-05-01T00:00:00.000Z",
    review_status: "up_to_date",
    review_state: "reviewed",
  };
  const { deps, launched, tasks } = makeStackedDeps({
    tasks: [task],
    prStatuses: { [STACK_PR_2]: "clean" },
    headShas: { [STACK_PR_2]: "head-2" },
    stateHashes: { [STACK_PR_2]: "hash-2" },
    baseBranches: { [STACK_PR_2]: "b1" },
    reviewMap: { [STACK_PR_2]: currentReview },
  });

  await pollOnce(new Map(), deps, new Map());

  assert.equal(tasks[0].stacked_prs?.[1].base_branch, "b1");
  assert.deepEqual(launched, [{ taskId: "task-1", mode: "review" }]);
});

test("pollOnce surfaces a closed unmerged base with a non-destructive decision run", async () => {
  const currentReview: ReviewSummary = {
    source: "task",
    task_id: "task-1",
    task_title: "t",
    task_description: "",
    task_plan: undefined,
    task_stack_position: 2,
    task_stack_size: 2,
    task_pr_scope: "Slice two",
    pr_url: STACK_PR_2,
    pr_number: 2,
    repo_slug: "acme/widget",
    title: "t (stack 2/2)",
    author: "",
    head_sha: "head-2",
    created_at: "",
    updated_at: "",
    summary: "Reviewed and fine",
    summary_head_sha: "head-2",
    generated_at: "2026-05-01T00:00:00.000Z",
    review_status: "up_to_date",
    review_state: "reviewed",
  };
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_1,
    branch_name: "b1",
    stacked_prs: [
      stackEntry(),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        last_review_gh_state: "hash-2",
        pr_status: "clean",
      }),
    ],
  });
  const { deps, launched, tasks } = makeStackedDeps({
    tasks: [task],
    // PR 1 is observed closing unmerged this poll; PR 2's hashes are
    // unchanged, so only the broken-stack condition can force the run.
    mergedOrClosed: { [STACK_PR_1]: "closed" },
    prStatuses: { [STACK_PR_2]: "clean" },
    headShas: { [STACK_PR_2]: "head-2" },
    stateHashes: { [STACK_PR_2]: "hash-2" },
    baseBranches: { [STACK_PR_2]: "b1" },
    reviewMap: { [STACK_PR_2]: currentReview },
  });

  await pollOnce(new Map(), deps, new Map());

  // The broken stack is surfaced through one review-mode run whose prompt
  // forbids rebasing and instructs a blocked decision request; the task
  // stays in review rather than completing without the closed slice.
  assert.deepEqual(launched, [{ taskId: "task-1", mode: "review" }]);
  assert.equal(tasks[0].status, "in_review");
  assert.equal(tasks[0].stacked_prs?.[0].state, "closed");

  // Once the agent records the blocked decision request, the worker stops
  // forcing runs and waits for the human.
  tasks[0] = {
    ...tasks[0],
    current_run_pid: undefined,
    current_run_mode: undefined,
    last_agent_report: {
      status: "blocked",
      summary: "Stack broken: PR 1 closed without merging",
      files_changed: [],
      assumptions: [],
      blockers: ["PR 1 closed without merging; needs a human decision"],
      next_steps: [],
    },
  };
  launched.length = 0;

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(launched, []);
  assert.equal(tasks[0].status, "in_review");
});

test("pollOnce treats a recorded-closed PR that GitHub reports merged as a merge", async () => {
  // The PR was reopened AND merged between polls: no intervening poll ever
  // observed it open. The merge must still capture the merge commit and
  // stamp the obligation on the open entry above.
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_2,
    branch_name: "b2",
    stack_decision_requested: `closed_base:${STACK_PR_2}<-b1`,
    stacked_prs: [
      stackEntry({ state: "closed" }),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        last_review_gh_state: "hash-2",
      }),
    ],
  });
  const { deps, tasks } = makeStackedDeps({
    tasks: [task],
    mergedOrClosed: { [STACK_PR_1]: "merged" },
    mergeCommitShas: { [STACK_PR_1]: "squash-1" },
    prStatuses: { [STACK_PR_2]: "clean" },
    headShas: { [STACK_PR_2]: "head-2" },
    stateHashes: { [STACK_PR_2]: "hash-2" },
  });

  await pollOnce(new Map(), deps, new Map());

  const stack = tasks[0].stacked_prs!;
  assert.equal(stack[0].state, "merged");
  assert.equal(stack[0].merge_commit_sha, "squash-1");
  assert.deepEqual(stack[1].pending_restack_of, ["squash-1"]);
  // The stale broken-stack acknowledgement is cleared with the closure gone.
  assert.equal(tasks[0].stack_decision_requested, undefined);
});

test("pollOnce leaves a merged PR open for retry when no merge commit is available", async () => {
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_1,
    branch_name: "b1",
    stacked_prs: [
      stackEntry({ last_review_gh_state: "hash-1" }),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        last_review_gh_state: "hash-2",
      }),
    ],
  });
  const { deps, tasks } = makeStackedDeps({
    tasks: [task],
    mergedOrClosed: { [STACK_PR_1]: "merged" },
    // No merge commit available: marking the entry merged anyway would
    // permanently bypass the ancestry verification.
    prStatuses: { [STACK_PR_1]: "clean", [STACK_PR_2]: "clean" },
    headShas: { [STACK_PR_1]: "head-1", [STACK_PR_2]: "head-2" },
    stateHashes: { [STACK_PR_1]: "hash-1", [STACK_PR_2]: "hash-2" },
  });

  await pollOnce(new Map(), deps, new Map());

  const stack = tasks[0].stacked_prs!;
  assert.equal(stack[0].state, "open");
  assert.equal(stack[0].merge_commit_sha, undefined);
  assert.equal(stack[1].pending_restack_of, undefined);
  assert.equal(tasks[0].status, "in_review");
});

test("pollOnce keeps forcing the decision run when it completes without a blocked report", async () => {
  const reviewFor = (
    prUrl: string,
    position: number,
    headSha: string
  ): ReviewSummary => ({
    source: "task",
    task_id: "task-1",
    task_title: "t",
    task_description: "",
    task_plan: undefined,
    task_stack_position: position,
    task_stack_size: 2,
    task_pr_scope: "Slice two",
    pr_url: prUrl,
    pr_number: position,
    repo_slug: "acme/widget",
    title: `t (stack ${position}/2)`,
    author: "",
    head_sha: headSha,
    created_at: "",
    updated_at: "",
    summary: "Reviewed and fine",
    summary_head_sha: headSha,
    generated_at: "2026-05-01T00:00:00.000Z",
    review_status: "up_to_date",
    review_state: "reviewed",
  });
  // An unrelated blocked report predates the closure. The decision launch
  // must disqualify it so a failed run cannot count as acknowledgement.
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_2,
    branch_name: "b2",
    last_agent_report: {
      status: "blocked",
      summary: "Blocked on an unrelated credential problem",
      files_changed: [],
      assumptions: [],
      blockers: ["missing credentials"],
      next_steps: [],
    },
    stacked_prs: [
      stackEntry({ state: "closed" }),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        last_review_gh_state: "hash-2",
        pr_status: "clean",
      }),
    ],
  });
  const { deps, launched, tasks } = makeStackedDeps({
    tasks: [task],
    mergedOrClosed: { [STACK_PR_1]: "closed" },
    prStatuses: { [STACK_PR_2]: "clean" },
    headShas: { [STACK_PR_2]: "head-2" },
    stateHashes: { [STACK_PR_2]: "hash-2" },
    reviewMap: { [STACK_PR_2]: reviewFor(STACK_PR_2, 2, "head-2") },
  });

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(launched, [{ taskId: "task-1", mode: "review" }]);
  // The stale unrelated report was disqualified at launch.
  assert.equal(tasks[0].last_agent_report, undefined);
  assert.ok(tasks[0].stack_decision_requested);

  // The run dies without producing a report (error/timeout/no structured
  // output): the fingerprint alone must not suppress the retry.
  tasks[0] = {
    ...tasks[0],
    current_run_pid: undefined,
    current_run_mode: undefined,
    last_run_result: "error",
  };
  launched.length = 0;

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(launched, [{ taskId: "task-1", mode: "review" }]);
});

test("pollOnce records the restack obligation on every open entry above a merge", async () => {
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_1,
    branch_name: "b1",
    stacked_prs: [
      stackEntry({ last_review_gh_state: "hash-1" }),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        last_review_gh_state: "hash-2",
      }),
      stackEntry({
        position: 3,
        pr_url: STACK_PR_3,
        branch_name: "b3",
        base_branch: "b2",
        scope: "Slice three",
        last_review_gh_state: "hash-3",
      }),
    ],
  });
  const { deps, tasks } = makeStackedDeps({
    tasks: [task],
    mergedOrClosed: { [STACK_PR_1]: "merged" },
    mergeCommitShas: { [STACK_PR_1]: "squash-1" },
    prStatuses: { [STACK_PR_2]: "clean", [STACK_PR_3]: "clean" },
    headShas: { [STACK_PR_2]: "head-2", [STACK_PR_3]: "head-3" },
    stateHashes: { [STACK_PR_2]: "hash-2", [STACK_PR_3]: "hash-3" },
  });

  await pollOnce(new Map(), deps, new Map());

  const stack = tasks[0].stacked_prs!;
  assert.equal(stack[0].state, "merged");
  assert.equal(stack[0].merge_commit_sha, "squash-1");
  // Both open entries above the merge carry the durable obligation.
  assert.deepEqual(stack[1].pending_restack_of, ["squash-1"]);
  assert.deepEqual(stack[2].pending_restack_of, ["squash-1"]);
});

test("pollOnce keeps the restack forced until GitHub verifies the rewrite", async () => {
  const currentReview: ReviewSummary = {
    source: "task",
    task_id: "task-1",
    task_title: "t",
    task_description: "",
    task_plan: undefined,
    task_stack_position: 2,
    task_stack_size: 2,
    task_pr_scope: "Slice two",
    pr_url: STACK_PR_2,
    pr_number: 2,
    repo_slug: "acme/widget",
    title: "t (stack 2/2)",
    author: "",
    head_sha: "head-2",
    created_at: "",
    updated_at: "",
    summary: "Reviewed and fine",
    summary_head_sha: "head-2",
    generated_at: "2026-05-01T00:00:00.000Z",
    review_status: "up_to_date",
    review_state: "reviewed",
  };
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_2,
    branch_name: "b2",
    stacked_prs: [
      stackEntry({ state: "merged", merge_commit_sha: "squash-1" }),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        // The base was retargeted to main, but the branch was never
        // rewritten: the pending obligation must keep the restack armed.
        base_branch: "main",
        scope: "Slice two",
        last_review_gh_state: "hash-2",
        pending_restack_of: ["squash-1"],
      }),
    ],
  });
  const options: StackedDepsOptions = {
    tasks: [task],
    prStatuses: { [STACK_PR_2]: "clean" },
    headShas: { [STACK_PR_2]: "head-2" },
    stateHashes: { [STACK_PR_2]: "hash-2" },
    baseBranches: { [STACK_PR_2]: "main" },
    ancestors: { "squash-1...head-2": false },
    reviewMap: { [STACK_PR_2]: currentReview },
  };
  const { deps, launched, tasks } = makeStackedDeps(options);

  await pollOnce(new Map(), deps, new Map());

  // Retarget alone does not clear the obligation: the run is still forced.
  assert.deepEqual(launched, [{ taskId: "task-1", mode: "review" }]);
  assert.deepEqual(tasks[0].stacked_prs?.[1].pending_restack_of, ["squash-1"]);

  // Once GitHub proves the merged commit is an ancestor of the head, the
  // obligation clears and no further run is forced.
  tasks[0] = {
    ...tasks[0],
    current_run_pid: undefined,
    current_run_mode: undefined,
  };
  options.ancestors = { "squash-1...head-2": true };
  launched.length = 0;

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(launched, []);
  assert.equal(tasks[0].stacked_prs?.[1].pending_restack_of, undefined);
});

test("pollOnce scopes the broken-stack acknowledgement to the exact condition", async () => {
  const reviewFor = (
    prUrl: string,
    position: number,
    headSha: string,
    scope: string
  ): ReviewSummary => ({
    source: "task",
    task_id: "task-1",
    task_title: "t",
    task_description: "",
    task_plan: undefined,
    task_stack_position: position,
    task_stack_size: 3,
    task_pr_scope: scope,
    pr_url: prUrl,
    pr_number: position,
    repo_slug: "acme/widget",
    title: `t (stack ${position}/3)`,
    author: "",
    head_sha: headSha,
    created_at: "",
    updated_at: "",
    summary: "Reviewed and fine",
    summary_head_sha: headSha,
    generated_at: "2026-05-01T00:00:00.000Z",
    review_status: "up_to_date",
    review_state: "reviewed",
  });
  // The task was already blocked for an UNRELATED reason before the closure:
  // that stale report must not suppress surfacing the closed base.
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_2,
    branch_name: "b2",
    last_agent_report: {
      status: "blocked",
      summary: "Blocked on an unrelated credential problem",
      files_changed: [],
      assumptions: [],
      blockers: ["missing credentials"],
      next_steps: [],
    },
    stacked_prs: [
      stackEntry({ state: "closed" }),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        last_review_gh_state: "hash-2",
        pr_status: "clean",
      }),
      stackEntry({
        position: 3,
        pr_url: STACK_PR_3,
        branch_name: "b3",
        base_branch: "b2",
        scope: "Slice three",
        last_review_gh_state: "hash-3",
        pr_status: "clean",
      }),
    ],
  });
  const options: StackedDepsOptions = {
    tasks: [task],
    mergedOrClosed: { [STACK_PR_1]: "closed" },
    prStatuses: { [STACK_PR_2]: "clean", [STACK_PR_3]: "clean" },
    headShas: { [STACK_PR_2]: "head-2", [STACK_PR_3]: "head-3" },
    stateHashes: { [STACK_PR_2]: "hash-2", [STACK_PR_3]: "hash-3" },
    reviewMap: {
      [STACK_PR_2]: reviewFor(STACK_PR_2, 2, "head-2", "Slice two"),
      [STACK_PR_3]: reviewFor(STACK_PR_3, 3, "head-3", "Slice three"),
    },
  };
  const { deps, launched, tasks } = makeStackedDeps(options);

  await pollOnce(new Map(), deps, new Map());

  // The unrelated blocked report does not count as acknowledgement.
  assert.deepEqual(launched, [{ taskId: "task-1", mode: "review" }]);
  const firstFingerprint = tasks[0].stack_decision_requested;
  assert.ok(firstFingerprint?.includes(STACK_PR_2));

  // The decision run records its blocked report for this exact condition:
  // no more forced runs for the same fingerprint.
  tasks[0] = {
    ...tasks[0],
    current_run_pid: undefined,
    current_run_mode: undefined,
    last_agent_report: {
      status: "blocked",
      summary: "Stack broken: PR 1 closed without merging",
      files_changed: [],
      assumptions: [],
      blockers: ["PR 1 closed without merging"],
      next_steps: [],
    },
  };
  launched.length = 0;
  await pollOnce(new Map(), deps, new Map());
  assert.deepEqual(launched, []);

  // A second, different closure produces a new fingerprint and is surfaced
  // again despite the recorded acknowledgement of the first one.
  options.mergedOrClosed = {
    [STACK_PR_1]: "closed",
    [STACK_PR_2]: "closed",
  };
  launched.length = 0;
  await pollOnce(new Map(), deps, new Map());
  assert.deepEqual(launched, [{ taskId: "task-1", mode: "review" }]);
  assert.notEqual(tasks[0].stack_decision_requested, firstFingerprint);
  assert.ok(tasks[0].stack_decision_requested?.includes(STACK_PR_3));
});

test("pollOnce reconciles a reopened stack PR and clears the stale acknowledgement", async () => {
  const currentReview: ReviewSummary = {
    source: "task",
    task_id: "task-1",
    task_title: "t",
    task_description: "",
    task_plan: undefined,
    task_stack_position: 2,
    task_stack_size: 2,
    task_pr_scope: "Slice two",
    pr_url: STACK_PR_2,
    pr_number: 2,
    repo_slug: "acme/widget",
    title: "t (stack 2/2)",
    author: "",
    head_sha: "head-2",
    created_at: "",
    updated_at: "",
    summary: "Reviewed and fine",
    summary_head_sha: "head-2",
    generated_at: "2026-05-01T00:00:00.000Z",
    review_status: "up_to_date",
    review_state: "reviewed",
  };
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_2,
    branch_name: "b2",
    stack_decision_requested: `closed_base:${STACK_PR_2}<-b1`,
    last_agent_report: {
      status: "blocked",
      summary: "Stack broken: PR 1 closed without merging",
      files_changed: [],
      assumptions: [],
      blockers: ["PR 1 closed without merging"],
      next_steps: [],
    },
    stacked_prs: [
      stackEntry({ state: "closed", last_review_gh_state: "hash-1" }),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        last_review_gh_state: "hash-2",
        pr_status: "clean",
      }),
    ],
  });
  const { deps, tasks } = makeStackedDeps({
    tasks: [task],
    // GitHub reports the closed PR open again (reopened by the human).
    mergedOrClosed: { [STACK_PR_1]: null, [STACK_PR_2]: null },
    prStatuses: { [STACK_PR_1]: "clean", [STACK_PR_2]: "clean" },
    headShas: { [STACK_PR_1]: "head-1", [STACK_PR_2]: "head-2" },
    stateHashes: { [STACK_PR_1]: "hash-1", [STACK_PR_2]: "hash-2" },
    reviewMap: { [STACK_PR_2]: currentReview },
  });

  await pollOnce(new Map(), deps, new Map());

  assert.equal(tasks[0].stacked_prs?.[0].state, "open");
  assert.equal(tasks[0].stack_decision_requested, undefined);
  // The reopened bottom entry becomes the frontier mirror again.
  assert.equal(tasks[0].pr_url, STACK_PR_1);
});

test("pollOnce leaves stacked tasks alone when hashes are unchanged and no restack is due", async () => {
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_1,
    branch_name: "b1",
    stacked_prs: [
      stackEntry({ last_review_gh_state: "hash-1", pr_status: "clean" }),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        last_review_gh_state: "hash-2",
        pr_status: "clean",
      }),
    ],
  });
  const reviewFor = (
    prUrl: string,
    position: number,
    headSha: string
  ): ReviewSummary => ({
    source: "task",
    task_id: "task-1",
    task_title: "t",
    task_description: "",
    task_plan: undefined,
    task_stack_position: position,
    task_stack_size: 2,
    task_pr_scope: position === 1 ? "Slice one" : "Slice two",
    pr_url: prUrl,
    pr_number: position,
    repo_slug: "acme/widget",
    title: `t (stack ${position}/2)`,
    author: "",
    head_sha: headSha,
    created_at: "",
    updated_at: "",
    summary: "Reviewed and fine",
    summary_head_sha: headSha,
    generated_at: "2026-05-01T00:00:00.000Z",
    review_status: "up_to_date",
    review_state: "reviewed",
  });
  const { deps, launched, tasks } = makeStackedDeps({
    tasks: [task],
    prStatuses: { [STACK_PR_1]: "clean", [STACK_PR_2]: "clean" },
    headShas: { [STACK_PR_1]: "head-1", [STACK_PR_2]: "head-2" },
    stateHashes: { [STACK_PR_1]: "hash-1", [STACK_PR_2]: "hash-2" },
    reviewMap: {
      [STACK_PR_1]: reviewFor(STACK_PR_1, 1, "head-1"),
      [STACK_PR_2]: reviewFor(STACK_PR_2, 2, "head-2"),
    },
  });

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(launched, []);
  assert.equal(tasks[0].status, "in_review");
  assert.equal(tasks[0].pr_url, STACK_PR_1);
});

test("pollOnce launches a stacked review run when any entry hash changes", async () => {
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_1,
    branch_name: "b1",
    stacked_prs: [
      stackEntry({ last_review_gh_state: "hash-1" }),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        last_review_gh_state: "stale-hash",
      }),
    ],
  });
  const reviewFor = (
    prUrl: string,
    position: number,
    headSha: string
  ): ReviewSummary => ({
    source: "task",
    task_id: "task-1",
    task_title: "t",
    task_description: "",
    task_plan: undefined,
    task_stack_position: position,
    task_stack_size: 2,
    task_pr_scope: position === 1 ? "Slice one" : "Slice two",
    pr_url: prUrl,
    pr_number: position,
    repo_slug: "acme/widget",
    title: `t (stack ${position}/2)`,
    author: "",
    head_sha: headSha,
    created_at: "",
    updated_at: "",
    summary: "Reviewed and fine",
    summary_head_sha: headSha,
    generated_at: "2026-05-01T00:00:00.000Z",
    review_status: "up_to_date",
    review_state: "reviewed",
  });
  const { deps, launched } = makeStackedDeps({
    tasks: [task],
    prStatuses: { [STACK_PR_1]: "clean", [STACK_PR_2]: "clean" },
    headShas: { [STACK_PR_1]: "head-1", [STACK_PR_2]: "head-2" },
    stateHashes: { [STACK_PR_1]: "hash-1", [STACK_PR_2]: "hash-2" },
    reviewMap: {
      [STACK_PR_1]: reviewFor(STACK_PR_1, 1, "head-1"),
      [STACK_PR_2]: reviewFor(STACK_PR_2, 2, "head-2"),
    },
  });

  await pollOnce(new Map(), deps, new Map());

  assert.deepEqual(launched, [{ taskId: "task-1", mode: "review" }]);
});

test("pollOnce queues per-entry stack reviews with slice context", async () => {
  const task = sample({
    id: "task-1",
    status: "in_review",
    pr_url: STACK_PR_1,
    branch_name: "b1",
    stacked_prs: [
      stackEntry(),
      stackEntry({
        position: 2,
        pr_url: STACK_PR_2,
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
      }),
    ],
  });
  const { deps, launched, upserted } = makeStackedDeps({
    tasks: [task],
    prStatuses: { [STACK_PR_1]: "clean", [STACK_PR_2]: "clean" },
    headShas: { [STACK_PR_1]: "head-1", [STACK_PR_2]: "head-2" },
    stateHashes: { [STACK_PR_1]: "hash-1", [STACK_PR_2]: "hash-2" },
  });

  await pollOnce(new Map(), deps, new Map());

  // No reviews exist yet, so the builder defers and the reviewer is queued
  // once per open stack entry with the slice context attached.
  assert.deepEqual(launched, []);
  const byUrl = new Map(upserted.map((review) => [review.pr_url, review]));
  const first = byUrl.get(STACK_PR_1);
  const second = byUrl.get(STACK_PR_2);
  assert.equal(first?.task_stack_position, 1);
  assert.equal(first?.task_stack_size, 2);
  assert.equal(first?.task_pr_scope, "Slice one");
  assert.equal(first?.title, "t (stack 1/2)");
  assert.equal(second?.task_stack_position, 2);
  assert.equal(second?.task_pr_scope, "Slice two");
  assert.equal(second?.head_sha, "head-2");
});

test("pollOnce skips automatic reviews when automatic review is disabled", async () => {
  const tasks: Task[] = [
    sample({
      id: "task-1",
      status: "in_review",
      pr_url: "https://github.com/acme/widget/pull/1",
      reviewer_agent_enabled: false,
      last_review_gh_state: "same-hash",
      agent_runner: "codex",
      permission_mode: "bypassPermissions",
    }),
  ];
  const launchedModes: string[] = [];
  let reviewLaunches = 0;
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
    removeFinalReviewWorkspace: async () => true,
    spawnAgentSession: async (_task, mode) => {
      launchedModes.push(mode);
      return { pid: 202, child: {} as never };
    },
    spawnReviewRetro: async () => ({
      pid: 0,
      child: {} as never,
      done: Promise.resolve(),
    }),
    spawnReviewSummary: async () => {
      reviewLaunches++;
      return {
        pid: 303,
        child: {} as never,
        done: Promise.resolve({} as never),
      };
    },
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
  assert.equal(reviewLaunches, 0);
  assert.equal(tasks[0].current_run_mode, undefined);
});
