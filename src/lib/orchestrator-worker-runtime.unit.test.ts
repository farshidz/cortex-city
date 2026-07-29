// In-process tests for the pure predicates that gate worker phases.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
    getPRHeadSha: async (prUrl) => options.headShas?.[prUrl] || "",
    getPRStateHash: async (prUrl) => options.stateHashes?.[prUrl] || "",
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
