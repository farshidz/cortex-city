// This module owns a single worker poll. The long-running loop, heartbeat, and
// signal handling stay in src/orchestrator-worker.ts so tests can exercise one
// poll without touching process lifecycle behavior.
import { spawnAgentSession, removeWorktree } from "./agent-runner";
import { shouldStartFinalCleanup } from "./final-task-cleanup";
import { getPRStateHash, getPRStatus, isPRMergedOrClosed } from "./github";
import {
  buildInterruptedTaskUpdates,
  getTaskRunMode,
  shouldResumeTask,
} from "./orchestrator-runtime";
import { deleteTask, getTask, readConfig, readTasks, updateTask } from "./store";
import type { Task } from "./types";

export const PRUNE_AGE_MS = 12 * 60 * 60 * 1000;

function shouldFinalizeCleanupWorktree(task: Task, hasActivePid: boolean): boolean {
  return Boolean(
    (task.status === "merged" || task.status === "closed") &&
      task.final_cleanup_state === "finished" &&
      task.worktree_path &&
      !hasActivePid
  );
}

function shouldResetStaleFinalCleanup(task: Task, hasActivePid: boolean): boolean {
  return Boolean(
    (task.status === "merged" || task.status === "closed") &&
      task.final_cleanup_state === "running" &&
      !task.current_run_pid &&
      !hasActivePid
  );
}

interface WorkerLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface WorkerRuntimeDeps {
  deleteTask: typeof deleteTask;
  getPRStateHash: typeof getPRStateHash;
  getPRStatus: typeof getPRStatus;
  getTask: typeof getTask;
  isPRMergedOrClosed: typeof isPRMergedOrClosed;
  isPidRunning: (pid: number) => boolean;
  logger: WorkerLogger;
  readConfig: typeof readConfig;
  readTasks: typeof readTasks;
  removeWorktree: typeof removeWorktree;
  spawnAgentSession: typeof spawnAgentSession;
  updateTask: typeof updateTask;
}

export const defaultWorkerRuntimeDeps: WorkerRuntimeDeps = {
  deleteTask,
  getPRStateHash,
  getPRStatus,
  getTask,
  isPRMergedOrClosed,
  isPidRunning: (pid) => {
    process.kill(pid, 0);
    return true;
  },
  logger: console,
  readConfig,
  readTasks,
  removeWorktree,
  spawnAgentSession,
  updateTask,
};

interface LaunchOptions {
  mode: "initial" | "review" | "cleanup";
  onComplete?: (taskId: string) => Promise<void> | void;
  postSpawnUpdates?: Partial<Task>;
  preSpawnUpdates?: Partial<Task>;
  rollbackOnError?: Partial<Task>;
}

async function launchTaskRun(
  task: Task,
  activePids: Map<string, number>,
  deps: WorkerRuntimeDeps,
  options: LaunchOptions
): Promise<boolean> {
  try {
    if (options.preSpawnUpdates) {
      await deps.updateTask(task.id, options.preSpawnUpdates);
    }

    const { pid } = await deps.spawnAgentSession(task, options.mode, async (taskId) => {
      activePids.delete(taskId);
      await options.onComplete?.(taskId);
    });

    activePids.set(task.id, pid);
    await deps.updateTask(task.id, {
      current_run_pid: pid,
      ...options.postSpawnUpdates,
    });
    return true;
  } catch (error) {
    activePids.delete(task.id);
    deps.logger.error(
      `[worker] Failed to start ${options.mode} run for task ${task.id}:`,
      error
    );
    if (options.rollbackOnError) {
      await deps.updateTask(task.id, options.rollbackOnError);
    }
    return false;
  }
}

export async function pollOnce(
  activePids = new Map<string, number>(),
  deps: WorkerRuntimeDeps = defaultWorkerRuntimeDeps
): Promise<void> {
  deps.logger.log("[worker] Poll phase: load state");
  let tasks = deps.readTasks();
  const config = deps.readConfig();

  deps.logger.log("[worker] Poll phase: reconcile task pids");
  const liveTaskIds = new Set<string>();
  for (const task of tasks) {
    if (!task.current_run_pid) {
      activePids.delete(task.id);
      continue;
    }

    try {
      if (!deps.isPidRunning(task.current_run_pid)) {
        throw new Error("process not running");
      }
      activePids.set(task.id, task.current_run_pid);
      liveTaskIds.add(task.id);
    } catch {
      deps.logger.log(
        `[worker] Clearing orphaned PID ${task.current_run_pid} for task ${task.id}`
      );
      activePids.delete(task.id);
      await deps.updateTask(task.id, buildInterruptedTaskUpdates(task));
    }
  }

  for (const taskId of [...activePids.keys()]) {
    if (!liveTaskIds.has(taskId)) {
      activePids.delete(taskId);
    }
  }

  for (const task of tasks) {
    if (!shouldResetStaleFinalCleanup(task, activePids.has(task.id))) continue;

    deps.logger.log(
      `[worker] Resetting stale final cleanup state for task "${task.title}" (${task.id})`
    );
    await deps.updateTask(task.id, {
      final_cleanup_state: undefined,
    });
  }

  tasks = deps.readTasks();

  deps.logger.log("[worker] Poll phase: cleanup final tasks");
  for (const task of tasks) {
    if (!shouldStartFinalCleanup(task, activePids.has(task.id))) continue;

    deps.logger.log(`[worker] Running cleanup for task "${task.title}" (${task.id})`);
    await launchTaskRun(task, activePids, deps, {
      mode: "cleanup",
      onComplete: async (taskId) => {
        const currentTask = await deps.getTask(taskId);
        if (!currentTask) return;
        await deps.updateTask(taskId, {
          final_cleanup_state: "finished",
          current_run_pid: undefined,
        });
        if (currentTask.worktree_path) {
          await deps.removeWorktree(currentTask);
          await deps.updateTask(taskId, {
            worktree_path: undefined,
          });
        }
      },
      preSpawnUpdates: {
        final_cleanup_state: "running",
      },
      rollbackOnError: {
        final_cleanup_state: undefined,
        current_run_pid: undefined,
      },
    });
  }

  tasks = deps.readTasks();

  deps.logger.log("[worker] Poll phase: finalize cleanup worktrees");
  for (const task of tasks) {
    if (!shouldFinalizeCleanupWorktree(task, activePids.has(task.id))) continue;

    deps.logger.log(`[worker] Removing leftover worktree for task "${task.title}" (${task.id})`);
    await deps.removeWorktree(task);
    await deps.updateTask(task.id, {
      worktree_path: undefined,
    });
  }

  tasks = deps.readTasks();

  deps.logger.log("[worker] Poll phase: prune old final tasks");
  const now = Date.now();
  for (const task of tasks) {
    if (
      (task.status === "merged" || task.status === "closed") &&
      !task.worktree_path &&
      !activePids.has(task.id) &&
      now - new Date(task.updated_at).getTime() > PRUNE_AGE_MS
    ) {
      await deps.deleteTask(task.id);
    }
  }

  tasks = deps.readTasks();

  let availableSlots = config.max_parallel_sessions - activePids.size;
  if (availableSlots <= 0) return;

  deps.logger.log("[worker] Poll phase: resume interrupted tasks");
  const resumableTasks = tasks
    .filter((task) => !activePids.has(task.id) && shouldResumeTask(task))
    .sort(
      (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    );

  for (const task of resumableTasks) {
    if (availableSlots <= 0) break;

    const runMode = getTaskRunMode(task);
    deps.logger.log(
      `[worker] Resuming task "${task.title}" (${task.id}) [${runMode}]`
    );
    const didLaunch = await launchTaskRun(task, activePids, deps, {
      mode: runMode,
      postSpawnUpdates: {
        resume_requested: undefined,
        pending_manual_instruction: undefined,
      },
      preSpawnUpdates: task.status === "open" ? { status: "in_progress" } : undefined,
      rollbackOnError:
        task.status === "open"
          ? { status: "open", current_run_pid: undefined }
          : undefined,
    });
    if (didLaunch) availableSlots--;
  }

  if (availableSlots <= 0) return;

  deps.logger.log("[worker] Poll phase: pick open tasks");
  const openTasks = tasks
    .filter(
      (task) =>
        !activePids.has(task.id) &&
        task.status === "open" &&
        (!task.session_id || Boolean(task.pending_manual_instruction))
    )
    .sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

  for (const task of openTasks) {
    if (availableSlots <= 0) break;

    deps.logger.log(`[worker] Picking up task "${task.title}" (${task.id}) [initial]`);
    const didLaunch = await launchTaskRun(task, activePids, deps, {
      mode: "initial",
      postSpawnUpdates: {
        pending_manual_instruction: undefined,
      },
      preSpawnUpdates: {
        status: "in_progress",
      },
      rollbackOnError: {
        status: "open",
        current_run_pid: undefined,
      },
    });
    if (didLaunch) availableSlots--;
  }

  deps.logger.log("[worker] Poll phase: scan in_review tasks");
  const inReviewTasks = tasks.filter(
    (task): task is Task & { pr_url: string } =>
      task.status === "in_review" && typeof task.pr_url === "string"
  );
  const tasksToReview: Task[] = [];

  await Promise.all(
    inReviewTasks.map(async (task) => {
      try {
        const hasManualInstruction = Boolean(task.pending_manual_instruction);
        const prState = await deps.isPRMergedOrClosed(task.pr_url);
        if (prState) {
          deps.logger.log(`[worker] PR ${prState} for "${task.title}"`);
          await deps.updateTask(task.id, { status: prState, pr_status: undefined });
          return;
        }

        const prStatus = await deps.getPRStatus(task.pr_url);
        if (prStatus !== "unknown" && prStatus !== task.pr_status) {
          await deps.updateTask(task.id, { pr_status: prStatus });
          task.pr_status = prStatus;
        }

        if (prStatus === "checks_pending" && !hasManualInstruction) return;
        if (activePids.has(task.id)) return;

        const ghState = await deps.getPRStateHash(task.pr_url);
        if (!ghState && !hasManualInstruction) return;

        const hasConflicts = prStatus === "conflicts";
        if (!hasManualInstruction && !hasConflicts && ghState === task.last_review_gh_state) {
          return;
        }

        tasksToReview.push(task);
      } catch (error) {
        deps.logger.error(`[worker] PR check failed for ${task.id}:`, error);
      }
    })
  );

  for (const task of tasksToReview) {
    if (availableSlots <= 0) break;

    deps.logger.log(`[worker] Picking up task "${task.title}" (${task.id}) [review]`);
    const didLaunch = await launchTaskRun(task, activePids, deps, {
      mode: "review",
      postSpawnUpdates: {
        pending_manual_instruction: undefined,
      },
    });
    if (didLaunch) availableSlots--;
  }
}
