// This module owns a single worker poll. The long-running loop, heartbeat, and
// signal handling stay in src/orchestrator-worker.ts so tests can exercise one
// poll without touching process lifecycle behavior.
import { spawnAgentSession, removeWorktree } from "./agent-runner";
import { shouldStartFinalCleanup } from "./final-task-cleanup";
import {
  getPRStateHash,
  getPRStatus,
  getReviewRequestedPRs,
  isPRMergedOrClosed,
} from "./github";
import {
  buildInterruptedTaskUpdates,
  getTaskRunMode,
  shouldResumeTask,
} from "./orchestrator-runtime";
import {
  deleteReviewSummary,
  readReviewSummaries,
  readReviewSummaryMap,
  upsertReviewSummary,
} from "./review-store";
import { spawnReviewSummary } from "./review-runner";
import { deleteTask, getTask, readConfig, readTasks, updateTask } from "./store";
import type { ReviewRequest, ReviewSummary, Task } from "./types";

export const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;

export function shouldFinalizeCleanupWorktree(task: Task, hasActivePid: boolean): boolean {
  return Boolean(
    (task.status === "merged" || task.status === "closed") &&
      task.final_cleanup_state === "finished" &&
      task.worktree_path &&
      !hasActivePid
  );
}

export function shouldResetStaleFinalCleanup(task: Task, hasActivePid: boolean): boolean {
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
  getReviewRequestedPRs: typeof getReviewRequestedPRs;
  getTask: typeof getTask;
  isPRMergedOrClosed: typeof isPRMergedOrClosed;
  isPidRunning: (pid: number) => boolean;
  logger: WorkerLogger;
  readConfig: typeof readConfig;
  readReviewSummaries: typeof readReviewSummaries;
  readReviewSummaryMap: typeof readReviewSummaryMap;
  readTasks: typeof readTasks;
  removeWorktree: typeof removeWorktree;
  spawnAgentSession: typeof spawnAgentSession;
  spawnReviewSummary: typeof spawnReviewSummary;
  updateTask: typeof updateTask;
  upsertReviewSummary: typeof upsertReviewSummary;
  deleteReviewSummary: typeof deleteReviewSummary;
}

export const defaultWorkerRuntimeDeps: WorkerRuntimeDeps = {
  deleteTask,
  getPRStateHash,
  getPRStatus,
  getReviewRequestedPRs,
  getTask,
  isPRMergedOrClosed,
  isPidRunning: (pid) => {
    process.kill(pid, 0);
    return true;
  },
  logger: console,
  readConfig,
  readReviewSummaries,
  readReviewSummaryMap,
  readTasks,
  removeWorktree,
  spawnAgentSession,
  spawnReviewSummary,
  updateTask,
  upsertReviewSummary,
  deleteReviewSummary,
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

    const launchState: { pid?: number } = {};
    const { pid } = await deps.spawnAgentSession(task, options.mode, async (taskId) => {
      if (launchState.pid === undefined || activePids.get(taskId) === launchState.pid) {
        activePids.delete(taskId);
      }
      await options.onComplete?.(taskId);
    });
    launchState.pid = pid;

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
  deps: WorkerRuntimeDeps = defaultWorkerRuntimeDeps,
  activeReviewPids: Map<string, number> = new Map()
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

  await runReviewPhases(activeReviewPids, deps, config);
}

function prFieldsFromRequest(request: ReviewRequest) {
  return {
    pr_url: request.pr_url,
    pr_number: request.pr_number,
    repo_slug: request.repo_slug,
    title: request.title,
    author: request.author,
    head_sha: request.head_sha,
    created_at: request.created_at,
    updated_at: request.updated_at,
    my_last_review_sha: request.my_last_review_sha,
  };
}

async function runReviewPhases(
  activeReviewPids: Map<string, number>,
  deps: WorkerRuntimeDeps,
  config: ReturnType<typeof readConfig>
): Promise<void> {
  deps.logger.log("[worker] Poll phase: reconcile review pids");
  const reviewMap = deps.readReviewSummaryMap();
  const liveReviewKeys = new Set<string>();
  for (const review of Object.values(reviewMap)) {
    if (!review.current_run_pid) {
      activeReviewPids.delete(review.pr_url);
      continue;
    }
    try {
      if (!deps.isPidRunning(review.current_run_pid)) {
        throw new Error("process not running");
      }
      activeReviewPids.set(review.pr_url, review.current_run_pid);
      liveReviewKeys.add(review.pr_url);
    } catch {
      deps.logger.log(
        `[worker] Clearing orphaned review PID ${review.current_run_pid} for ${review.pr_url}`
      );
      activeReviewPids.delete(review.pr_url);
      await deps.upsertReviewSummary({ ...review, current_run_pid: undefined });
    }
  }
  for (const prUrl of [...activeReviewPids.keys()]) {
    if (!liveReviewKeys.has(prUrl)) {
      activeReviewPids.delete(prUrl);
    }
  }

  deps.logger.log("[worker] Poll phase: scan review requests");
  let openReviewRequests: ReviewRequest[] = [];
  try {
    openReviewRequests = await deps.getReviewRequestedPRs();
  } catch (error) {
    deps.logger.error("[worker] Failed to fetch review-requested PRs:", error);
    return;
  }

  for (const pr of openReviewRequests) {
    const cached = deps.readReviewSummaryMap()[pr.pr_url];
    if (!cached) {
      await deps.upsertReviewSummary({
        ...prFieldsFromRequest(pr),
        summary: "",
        generated_at: "",
      });
      continue;
    }
    if (cached.head_sha !== pr.head_sha) {
      await deps.upsertReviewSummary({
        ...cached,
        ...prFieldsFromRequest(pr),
        summary: "",
        generated_at: "",
        session_id: undefined,
        followups: [],
        error: undefined,
        final_at: undefined,
      });
      continue;
    }
    const wasFinal = Boolean(cached.final_at);
    const reviewShaChanged =
      cached.my_last_review_sha !== pr.my_last_review_sha;
    if (wasFinal || reviewShaChanged) {
      await deps.upsertReviewSummary({
        ...cached,
        ...prFieldsFromRequest(pr),
        final_at: undefined,
      });
    }
  }

  const maxParallelReviews = Math.max(1, config.max_parallel_reviews ?? 2);
  let reviewSlots = maxParallelReviews - activeReviewPids.size;
  if (reviewSlots > 0) {
    const refreshed = deps.readReviewSummaryMap();
    for (const pr of openReviewRequests) {
      if (reviewSlots <= 0) break;
      if (activeReviewPids.has(pr.pr_url)) continue;
      const cached = refreshed[pr.pr_url];
      const needsSummary =
        !cached?.summary || cached.head_sha !== pr.head_sha;
      if (!needsSummary) continue;
      try {
        const { pid } = await deps.spawnReviewSummary(pr, {}, async () => {
          activeReviewPids.delete(pr.pr_url);
        });
        activeReviewPids.set(pr.pr_url, pid);
        reviewSlots--;
        deps.logger.log(`[worker] Spawned review summary for ${pr.pr_url}`);
      } catch (error) {
        deps.logger.error(
          `[worker] Failed to spawn review summary for ${pr.pr_url}:`,
          error
        );
      }
    }
  }

  deps.logger.log("[worker] Poll phase: prune old reviews");
  const openSet = new Set(openReviewRequests.map((r) => r.pr_url));
  const now = Date.now();
  const reviewsForGC: ReviewSummary[] = Object.values(deps.readReviewSummaryMap());
  for (const review of reviewsForGC) {
    if (activeReviewPids.has(review.pr_url)) continue;
    if (!review.final_at && !openSet.has(review.pr_url)) {
      await deps.upsertReviewSummary({
        ...review,
        final_at: new Date().toISOString(),
      });
      continue;
    }
    if (
      review.final_at &&
      now - new Date(review.final_at).getTime() > PRUNE_AGE_MS
    ) {
      await deps.deleteReviewSummary(review.pr_url);
    }
  }
}
