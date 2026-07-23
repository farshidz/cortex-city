// This module owns a single worker poll. The long-running loop, heartbeat, and
// signal handling stay in src/orchestrator-worker.ts so tests can exercise one
// poll without touching process lifecycle behavior.
import { statSync } from "fs";
import { spawnAgentSession, removeWorktree } from "./agent-runner";
import {
  isFinalTask,
  shouldClearMissingFinalWorktreePath,
  shouldStartFinalCleanup,
} from "./final-task-cleanup";
import {
  deliverReviewerComment,
  getPRHeadSha,
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
  clearReviewRunIfMatching,
  deleteReviewSummary,
  deleteReviewSummaryIf,
  mutateReviewSummary,
  readReviewSummaries,
  readReviewSummaryMap,
  upsertReviewSummary,
} from "./review-store";
import { readReviewLearnings } from "./review-learnings-store";
import { spawnReviewRetro } from "./review-learnings-runner";
import { resolveReviewOpts, spawnReviewSummary } from "./review-runner";
import { removeFinalReviewWorkspace } from "./review-workspace";
import { reviewerCommentBodySha256 } from "./review-comments";
import { unlinkTask as unlinkIssueTask } from "./issue-store";
import { deleteTask, getTask, readConfig, readTasks, updateTask } from "./store";
import { assertSufficientDiskSpace } from "./disk-guard";
import type { ReviewRequest, ReviewSummary, Task, TaskRunMode } from "./types";

export const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
export const DEAD_OWNED_PID_GRACE_MS = 10_000;
export const FINAL_CLASSIFICATION_RETRY_MS = 15 * 60 * 1000;
export const REVIEW_ERROR_RETRY_MS = 5 * 60 * 1000;
const REVIEW_DECISION_ACTION_INTERRUPTED_ERROR =
  "The reviewer comment delivery was interrupted before its result was saved.";

export interface DeadOwnedPid {
  pid: number;
  firstSeenAt: number;
}

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
    isFinalTask(task) &&
      task.final_cleanup_state === "running" &&
      (!task.current_run_pid || !task.worktree_path) &&
      !hasActivePid
  );
}

export function shouldCleanupFinalReviewWorkspace(
  review: ReviewSummary,
  learningEnabled: boolean,
  hasActivePid: boolean
): boolean {
  return Boolean(
    review.final_at &&
      !hasActivePid &&
      review.current_run_pid == null &&
      review.current_run_id == null &&
      review.retro_run_pid == null &&
      (!learningEnabled || review.retro_status !== "pending")
  );
}

export function shouldWaitForDeadOwnedPid(
  task: Task,
  activePids: Map<string, number>,
  deadOwnedPids: Map<string, DeadOwnedPid>,
  now = Date.now()
): boolean {
  const currentPid = task.current_run_pid;
  if (typeof currentPid !== "number") return false;
  if (activePids.get(task.id) !== currentPid) return false;

  const existing = deadOwnedPids.get(task.id);
  if (!existing || existing.pid !== currentPid) {
    deadOwnedPids.set(task.id, {
      pid: currentPid,
      firstSeenAt: now,
    });
    return true;
  }

  return now - existing.firstSeenAt < DEAD_OWNED_PID_GRACE_MS;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function hasWorktreeDirectory(task: Pick<Task, "worktree_path">): boolean {
  return Boolean(task.worktree_path && isDirectory(task.worktree_path));
}

interface WorkerLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface WorkerRuntimeDeps {
  deleteTask: typeof deleteTask;
  getPRHeadSha?: typeof getPRHeadSha;
  getPRStateHash: typeof getPRStateHash;
  getPRStatus: typeof getPRStatus;
  getReviewRequestedPRs: typeof getReviewRequestedPRs;
  getTask: typeof getTask;
  isPRMergedOrClosed: typeof isPRMergedOrClosed;
  isPidRunning: (pid: number) => boolean;
  stopLegacyReviewerProcess?: (pid: number) => void;
  logger: WorkerLogger;
  readConfig: typeof readConfig;
  readReviewSummaries: typeof readReviewSummaries;
  readReviewSummaryMap: typeof readReviewSummaryMap;
  readReviewLearnings: typeof readReviewLearnings;
  readTasks: typeof readTasks;
  removeWorktree: typeof removeWorktree;
  removeFinalReviewWorkspace: typeof removeFinalReviewWorkspace;
  spawnReviewRetro: typeof spawnReviewRetro;
  spawnAgentSession: typeof spawnAgentSession;
  spawnReviewSummary: typeof spawnReviewSummary;
  updateTask: typeof updateTask;
  upsertReviewSummary: typeof upsertReviewSummary;
  clearReviewRunIfMatching?: typeof clearReviewRunIfMatching;
  deleteReviewSummaryIf?: typeof deleteReviewSummaryIf;
  mutateReviewSummary?: typeof mutateReviewSummary;
  deleteReviewSummary: typeof deleteReviewSummary;
  deliverReviewerComment?: typeof deliverReviewerComment;
}

export const defaultWorkerRuntimeDeps: WorkerRuntimeDeps = {
  deleteTask,
  getPRHeadSha,
  getPRStateHash,
  getPRStatus,
  getReviewRequestedPRs,
  getTask,
  isPRMergedOrClosed,
  isPidRunning: (pid) => {
    process.kill(pid, 0);
    return true;
  },
  stopLegacyReviewerProcess: (pid) => {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  },
  logger: console,
  readConfig,
  readReviewLearnings,
  readReviewSummaries,
  readReviewSummaryMap,
  readTasks,
  removeWorktree,
  removeFinalReviewWorkspace,
  spawnAgentSession,
  spawnReviewRetro,
  spawnReviewSummary,
  updateTask,
  upsertReviewSummary,
  clearReviewRunIfMatching,
  deleteReviewSummaryIf,
  mutateReviewSummary,
  deleteReviewSummary,
  deliverReviewerComment,
};

interface LaunchOptions {
  mode: TaskRunMode;
  onComplete?: (taskId: string) => Promise<void> | void;
  postSpawnUpdates?: Partial<Task>;
  preSpawnUpdates?: Partial<Task>;
  rollbackOnError?: Partial<Task>;
}

interface ReviewRunCandidate {
  task: Task & { pr_url: string };
  ghState: string;
  hasConflicts: boolean;
}

function isAutomaticReviewEnabled(
  task: Pick<Task, "reviewer_agent_enabled">
): boolean {
  return task.reviewer_agent_enabled !== false;
}

function taskReviewRequest(
  task: Task & { pr_url: string },
  headSha: string
): ReviewRequest | undefined {
  const match = task.pr_url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/
  );
  if (!match || !headSha.trim()) return undefined;

  return {
    source: "task",
    task_id: task.id,
    task_title: task.title,
    task_description: task.description,
    task_plan: task.plan,
    pr_url: task.pr_url,
    pr_number: Number(match[3]),
    repo_slug: `${match[1]}/${match[2]}`,
    title: task.title,
    author: "",
    head_sha: headSha.trim(),
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function shouldDeferBuilderForStoredReview(
  task: Task,
  reviewMap: Record<string, ReviewSummary>,
  activeReviewPids: Map<string, number>,
  taskReviewHeads: Map<string, string>
): boolean {
  if (
    task.status !== "in_review" ||
    !task.pr_url ||
    !isAutomaticReviewEnabled(task)
  ) {
    return false;
  }
  if (activeReviewPids.has(task.pr_url)) return true;
  const review = reviewMap[task.pr_url];
  if (review?.current_run_pid != null) return true;
  // A currently unschedulable review must not deadlock explicit implementation
  // work. Once schedulable, however, a review from another source or older task
  // context must be rerun before the builder can proceed.
  const currentHeadSha = taskReviewHeads.get(task.pr_url);
  if (!currentHeadSha) return false;
  if (task.review_migration_head_sha === currentHeadSha) return false;
  const taskContextMatches =
    review?.source === "task" &&
    review.task_id === task.id &&
    review.task_title === task.title &&
    review.task_description === task.description &&
    review.task_plan === task.plan;
  if (!taskContextMatches) return true;
  // A failed review retries independently with backoff, but must not deadlock
  // explicit implementation work while the reviewer configuration is repaired.
  if (review.error) return false;
  if (!review || !review.summary?.trim()) return true;
  return summaryHeadShaFor(review) !== currentHeadSha;
}

function normalizedReviewProfile(review: ReviewSummary) {
  if (review.session_profile) {
    return {
      runtime: review.session_profile.runtime,
      effort: review.session_profile.effort,
      model: review.session_profile.model?.trim() || undefined,
    };
  }
  if (!review.runtime) return undefined;
  return {
    runtime: review.runtime,
    effort: review.effort,
    model: review.model?.trim() || undefined,
  };
}

export function shouldRetryErroredReview(
  review: ReviewSummary,
  config: ReturnType<typeof readConfig>,
  now = Date.now()
): boolean {
  if (!review.error) return true;
  const previous = normalizedReviewProfile(review);
  const next = resolveReviewOpts(config);
  if (
    !previous ||
    previous.runtime !== next.runtime ||
    previous.effort !== next.effort ||
    previous.model !== (next.model?.trim() || undefined)
  ) {
    return true;
  }
  const failedAt = review.error_at ? new Date(review.error_at).getTime() : NaN;
  return !Number.isFinite(failedAt) || now - failedAt >= REVIEW_ERROR_RETRY_MS;
}

let activeRetroPid: number | undefined;

async function launchTaskRun(
  task: Task,
  activePids: Map<string, number>,
  deps: WorkerRuntimeDeps,
  options: LaunchOptions
): Promise<boolean> {
  try {
    assertSufficientDiskSpace(`launching ${options.mode} run for task ${task.id}`);

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
      current_run_mode: options.mode,
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

async function recoverPendingReviewerCommentDeliveries(
  deps: WorkerRuntimeDeps
): Promise<void> {
  if (!deps.deliverReviewerComment) return;
  for (const review of Object.values(deps.readReviewSummaryMap())) {
    const delivery = review.pending_reviewer_comment_delivery;
    if (
      !delivery ||
      review.current_run_pid != null ||
      review.current_run_id != null
    ) {
      continue;
    }
    try {
      const existingReceipt = review.reviewer_comment_receipts?.find(
        (candidate) =>
          candidate.action_token === delivery.action_token &&
          candidate.body_sha256 === reviewerCommentBodySha256(delivery.body)
      );
      const deliveredReceipt =
        existingReceipt ||
        (await deps.deliverReviewerComment(review.pr_url, delivery));
      await mutateStoredReview(deps, review.pr_url, (current) => {
        const pending = current?.pending_reviewer_comment_delivery;
        if (
          !current ||
          current.current_run_pid != null ||
          current.current_run_id != null ||
          !pending ||
          pending.action_token !== delivery.action_token ||
          pending.body !== delivery.body
        ) {
          return undefined;
        }
        return {
          ...current,
          reviewer_comment_receipts: [
            ...(current.reviewer_comment_receipts || []).filter(
              (candidate) =>
                candidate.action_token !== deliveredReceipt.action_token &&
                candidate.comment_id !== deliveredReceipt.comment_id
            ),
            deliveredReceipt,
          ],
          // The delivery is complete, but the process died before saving its
          // review result. Retain the durable action so an identical rebuild
          // reuses it rather than posting a second event.
          pending_reviewer_comment_delivery: pending,
          agent_review_status: undefined,
          error: REVIEW_DECISION_ACTION_INTERRUPTED_ERROR,
          error_at:
            current.error === REVIEW_DECISION_ACTION_INTERRUPTED_ERROR &&
            current.error_at
              ? current.error_at
              : new Date().toISOString(),
        };
      });
    } catch (error) {
      deps.logger.error(
        `[worker] Failed to recover reviewer comment delivery for ${review.pr_url}:`,
        error
      );
      await mutateStoredReview(deps, review.pr_url, (current) => {
        if (
          !current ||
          current.current_run_pid != null ||
          current.current_run_id != null ||
          current.pending_reviewer_comment_delivery?.action_token !==
            delivery.action_token ||
          current.error
        ) {
          return undefined;
        }
        return {
          ...current,
          error: REVIEW_DECISION_ACTION_INTERRUPTED_ERROR,
          error_at: new Date().toISOString(),
        };
      });
    }
  }
}

export async function pollOnce(
  activePids = new Map<string, number>(),
  deps: WorkerRuntimeDeps = defaultWorkerRuntimeDeps,
  activeReviewPids: Map<string, number> = new Map(),
  deadOwnedPids: Map<string, DeadOwnedPid> = new Map()
): Promise<void> {
  deps.logger.log("[worker] Poll phase: load state");
  let tasks = deps.readTasks();
  const config = deps.readConfig();
  const pollStartedAt = Date.now();
  deps.logger.log("[worker] Poll phase: recover reviewer comment deliveries");
  await recoverPendingReviewerCommentDeliveries(deps);
  const initialTaskUpdatedAt = new Map(
    tasks.map((task) => [task.id, new Date(task.updated_at).getTime()])
  );
  const pruneAfterMetadataCleanupTaskIds = new Set<string>();

  const rememberPruneEligibility = (task: Task) => {
    const updatedAt = initialTaskUpdatedAt.get(task.id);
    if (updatedAt !== undefined && pollStartedAt - updatedAt > PRUNE_AGE_MS) {
      pruneAfterMetadataCleanupTaskIds.add(task.id);
    }
  };

  deps.logger.log("[worker] Poll phase: reconcile task pids");
  const liveTaskIds = new Set<string>();
  for (const task of tasks) {
    if (!task.current_run_pid) {
      activePids.delete(task.id);
      deadOwnedPids.delete(task.id);
      continue;
    }

    try {
      if (!deps.isPidRunning(task.current_run_pid)) {
        throw new Error("process not running");
      }
      if ((task.current_run_mode as string | undefined) === "reviewer") {
        deps.logger.log(
          `[worker] Stopping retired reviewer PID ${task.current_run_pid} for task ${task.id}`
        );
        deps.stopLegacyReviewerProcess?.(task.current_run_pid);
      }
      activePids.set(task.id, task.current_run_pid);
      deadOwnedPids.delete(task.id);
      liveTaskIds.add(task.id);
    } catch {
      if (shouldWaitForDeadOwnedPid(task, activePids, deadOwnedPids)) {
        liveTaskIds.add(task.id);
        deps.logger.log(
          `[worker] Waiting for completed PID ${task.current_run_pid} to settle for task ${task.id}`
        );
        continue;
      }
      deps.logger.log(
        `[worker] Clearing orphaned PID ${task.current_run_pid} for task ${task.id}`
      );
      activePids.delete(task.id);
      deadOwnedPids.delete(task.id);
      await deps.updateTask(task.id, buildInterruptedTaskUpdates(task));
    }
  }

  for (const taskId of [...activePids.keys()]) {
    if (!liveTaskIds.has(taskId)) {
      activePids.delete(taskId);
      deadOwnedPids.delete(taskId);
    }
  }

  for (const task of tasks) {
    if (!shouldResetStaleFinalCleanup(task, activePids.has(task.id))) continue;

    deps.logger.log(
      `[worker] Resetting stale final cleanup state for task "${task.title}" (${task.id})`
    );
    if (!task.worktree_path || !hasWorktreeDirectory(task)) {
      rememberPruneEligibility(task);
    }
    await deps.updateTask(task.id, {
      final_cleanup_state: undefined,
    });
  }

  tasks = deps.readTasks();

  deps.logger.log("[worker] Poll phase: clear missing final worktrees");
  for (const task of tasks) {
    if (
      !shouldClearMissingFinalWorktreePath(
        task,
        activePids.has(task.id),
        hasWorktreeDirectory(task)
      )
    ) {
      continue;
    }

    deps.logger.log(
      `[worker] Clearing missing worktree path for final task "${task.title}" (${task.id})`
    );
    rememberPruneEligibility(task);
    await deps.updateTask(task.id, {
      worktree_path: undefined,
      final_cleanup_state:
        task.final_cleanup_state === "running" ? undefined : task.final_cleanup_state,
    });
  }

  tasks = deps.readTasks();

  deps.logger.log("[worker] Poll phase: cleanup final tasks");
  for (const task of tasks) {
    if (
      !shouldStartFinalCleanup(
        task,
        activePids.has(task.id),
        hasWorktreeDirectory(task)
      )
    ) {
      continue;
    }

    deps.logger.log(`[worker] Running cleanup for task "${task.title}" (${task.id})`);
    await launchTaskRun(task, activePids, deps, {
      mode: "cleanup",
      onComplete: async (taskId) => {
        const currentTask = await deps.getTask(taskId);
        if (!currentTask) return;
        await deps.updateTask(taskId, {
          final_cleanup_state: "finished",
          current_run_pid: undefined,
          current_run_mode: undefined,
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
        current_run_mode: undefined,
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
      isFinalTask(task) &&
      !task.worktree_path &&
      !activePids.has(task.id) &&
      (now - new Date(task.updated_at).getTime() > PRUNE_AGE_MS ||
        pruneAfterMetadataCleanupTaskIds.has(task.id))
    ) {
      await deps.deleteTask(task.id);
      if (task.issue_id) {
        await unlinkIssueTask(task.issue_id, { keepTerminalStatus: true }).catch(
          () => {}
        );
      }
    }
  }

  tasks = deps.readTasks();

  deps.logger.log("[worker] Poll phase: resolve task review heads");
  const taskReviewHeads = new Map<string, string>();
  const storedReviewsBeforeHeadResolution = deps.readReviewSummaryMap();
  await Promise.all(
    tasks
      .filter(
        (task): task is Task & { pr_url: string } => {
          if (
            task.paused ||
            task.status !== "in_review" ||
            typeof task.pr_url !== "string" ||
            activePids.has(task.id)
          ) {
            return false;
          }
          if (isAutomaticReviewEnabled(task)) return true;
          const storedReview = storedReviewsBeforeHeadResolution[task.pr_url];
          return (
            storedReview?.source === "task" &&
            storedReview.task_id === task.id
          );
        }
      )
      .map(async (task) => {
        try {
          const headSha = (await deps.getPRHeadSha?.(task.pr_url))?.trim();
          if (headSha) {
            if (
              task.review_migration_head_sha &&
              task.review_migration_head_sha !== headSha
            ) {
              const updated = await deps.updateTask(task.id, {
                review_migration_head_sha: undefined,
              });
              task.review_migration_head_sha = undefined;
              task.updated_at = updated.updated_at;
            }
            taskReviewHeads.set(task.pr_url, headSha);
          }
        } catch (error) {
          deps.logger.error(
            `[worker] Failed to resolve review head for ${task.id}:`,
            error
          );
        }
      })
  );
  let availableSlots = config.max_parallel_sessions - activePids.size;
  const storedReviewsBeforeTaskRuns = deps.readReviewSummaryMap();

  deps.logger.log("[worker] Poll phase: resume interrupted tasks");
  const resumableTasks = tasks
    .filter(
      (task) =>
        !task.paused &&
        !activePids.has(task.id) &&
        shouldResumeTask(task) &&
        !shouldDeferBuilderForStoredReview(
          task,
          storedReviewsBeforeTaskRuns,
          activeReviewPids,
          taskReviewHeads
        )
    )
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
        resume_run_mode: undefined,
        pending_manual_instruction: undefined,
      },
      preSpawnUpdates: task.status === "open" ? { status: "in_progress" } : undefined,
      rollbackOnError:
        task.status === "open"
          ? { status: "open", current_run_pid: undefined, current_run_mode: undefined }
          : { current_run_pid: undefined, current_run_mode: undefined },
    });
    if (didLaunch) availableSlots--;
  }

  deps.logger.log("[worker] Poll phase: pick open tasks");
  const openTasks = tasks
    .filter(
      (task) =>
        !task.paused &&
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
        current_run_mode: undefined,
      },
    });
    if (didLaunch) availableSlots--;
  }

  deps.logger.log("[worker] Poll phase: scan in_review tasks");
  const liveTaskOwners = new Map(
    tasks
      .filter(
        (task): task is Task & { pr_url: string } =>
          task.status === "in_review" && typeof task.pr_url === "string"
      )
      .map((task) => [task.pr_url, task] as const)
  );
  const inReviewTasks = tasks.filter(
    (task): task is Task & { pr_url: string } =>
      !task.paused && task.status === "in_review" && typeof task.pr_url === "string"
  );
  const taskReviewRequests: ReviewRequest[] = [];
  const refreshOnlyTaskReviewRequests: ReviewRequest[] = [];
  const tasksToReview: ReviewRunCandidate[] = [];

  await Promise.all(
    inReviewTasks.map(async (task) => {
      try {
        const hasManualInstruction = Boolean(task.pending_manual_instruction);
        const prState = await deps.isPRMergedOrClosed(task.pr_url);
        if (prState) {
          deps.logger.log(`[worker] PR ${prState} for "${task.title}"`);
          liveTaskOwners.delete(task.pr_url);
          await deps.updateTask(task.id, { status: prState, pr_status: undefined });
          return;
        }

        const prStatus = await deps.getPRStatus(task.pr_url);
        if (prStatus !== "unknown" && prStatus !== task.pr_status) {
          await deps.updateTask(task.id, { pr_status: prStatus });
          task.pr_status = prStatus;
        }

        if (activePids.has(task.id)) return;

        const automaticReviewEnabled = isAutomaticReviewEnabled(task);
        const headSha = taskReviewHeads.get(task.pr_url) || "";
        const cached = deps.readReviewSummaryMap()[task.pr_url];
        const request =
          task.review_migration_head_sha === headSha
            ? undefined
            : taskReviewRequest(task, headSha);
        if (automaticReviewEnabled) {
          if (request) {
            taskReviewRequests.push(request);
            const reviewedHeadSha = cached ? summaryHeadShaFor(cached) : undefined;
            if (cached?.current_run_pid != null) return;
            if (
              (!cached?.summary?.trim() ||
                reviewedHeadSha !== request.head_sha) &&
              !cached?.error
            ) {
              return;
            }
          }
        } else if (
          request &&
          cached?.source === "task" &&
          cached.task_id === task.id
        ) {
          // Opting out prevents new review runs, but an existing result still
          // needs the current HEAD so the task UI can show that it is stale.
          refreshOnlyTaskReviewRequests.push(request);
        }

        if (prStatus === "checks_pending" && !hasManualInstruction) return;

        const ghState = await deps.getPRStateHash(task.pr_url);
        if (!ghState && !hasManualInstruction) return;

        const hasConflicts = prStatus === "conflicts";
        if (!hasManualInstruction && !hasConflicts && ghState === task.last_review_gh_state) {
          return;
        }

        tasksToReview.push({ task, ghState, hasConflicts });
      } catch (error) {
        deps.logger.error(`[worker] PR check failed for ${task.id}:`, error);
      }
    })
  );

  for (const candidate of tasksToReview) {
    if (availableSlots <= 0) break;
    const task = await deps.getTask(candidate.task.id);
    if (
      !task ||
      task.status !== "in_review" ||
      typeof task.pr_url !== "string" ||
      task.pr_url !== candidate.task.pr_url
    ) {
      continue;
    }

    const hasManualInstruction = Boolean(task.pending_manual_instruction);
    const hasConflicts = task.pr_status === "conflicts" || candidate.hasConflicts;
    if (task.current_run_pid || activePids.has(task.id)) continue;
    if (
      shouldDeferBuilderForStoredReview(
        task,
        deps.readReviewSummaryMap(),
        activeReviewPids,
        taskReviewHeads
      )
    ) {
      continue;
    }
    if (!candidate.ghState && !hasManualInstruction) continue;
    if (
      !hasManualInstruction &&
      !hasConflicts &&
      candidate.ghState === task.last_review_gh_state
    ) {
      continue;
    }

    deps.logger.log(`[worker] Picking up task "${task.title}" (${task.id}) [review]`);
    const didLaunch = await launchTaskRun(task, activePids, deps, {
      mode: "review",
      postSpawnUpdates: {
        pending_manual_instruction: undefined,
      },
    });
    if (didLaunch) availableSlots--;
  }

  await runReviewPhases(
    activeReviewPids,
    deps,
    config,
    taskReviewRequests.filter(
      (request) => !request.task_id || !activePids.has(request.task_id)
    ),
    refreshOnlyTaskReviewRequests.filter(
      (request) => !request.task_id || !activePids.has(request.task_id)
    ),
    liveTaskOwners
  );
}

function prFieldsFromRequest(request: ReviewRequest) {
  return {
    source: request.source || "inbound",
    task_id: request.task_id,
    task_title: request.task_title,
    task_description: request.task_description,
    task_plan: request.task_plan,
    label_only: request.label_only,
    self_authored: request.self_authored,
    pr_url: request.pr_url,
    pr_number: request.pr_number,
    repo_slug: request.repo_slug,
    title: request.title,
    author: request.author,
    head_sha: request.head_sha,
    created_at: request.created_at,
    updated_at: request.updated_at,
    my_last_review_sha: request.my_last_review_sha,
    my_approval_sha: request.my_approval_sha,
    my_changes_requested_sha: request.my_changes_requested_sha,
  };
}

function summaryHeadShaFor(
  review: Pick<ReviewSummary, "head_sha" | "summary" | "summary_head_sha">
): string | undefined {
  return review.summary_head_sha || (review.summary?.trim() ? review.head_sha : undefined);
}

async function mutateStoredReview(
  deps: WorkerRuntimeDeps,
  prUrl: string,
  updater: Parameters<typeof mutateReviewSummary>[1]
): Promise<ReviewSummary | undefined> {
  if (deps.mutateReviewSummary) {
    return deps.mutateReviewSummary(prUrl, updater);
  }
  const next = updater(deps.readReviewSummaryMap()[prUrl]);
  return next ? deps.upsertReviewSummary(next) : undefined;
}

async function deleteStoredReviewIf(
  deps: WorkerRuntimeDeps,
  prUrl: string,
  predicate: (current: ReviewSummary) => boolean
): Promise<boolean> {
  if (deps.deleteReviewSummaryIf) {
    return deps.deleteReviewSummaryIf(prUrl, predicate);
  }
  const current = deps.readReviewSummaryMap()[prUrl];
  if (!current || !predicate(current)) return false;
  await deps.deleteReviewSummary(prUrl);
  return true;
}

async function runReviewPhases(
  activeReviewPids: Map<string, number>,
  deps: WorkerRuntimeDeps,
  config: ReturnType<typeof readConfig>,
  taskReviewRequests: ReviewRequest[] = [],
  refreshOnlyTaskReviewRequests: ReviewRequest[] = [],
  liveTaskOwners: Map<string, Task & { pr_url: string }> = new Map()
): Promise<void> {
  const learningEnabled = config.review_learning_enabled !== false;
  const liveTaskPrUrls = new Set(liveTaskOwners.keys());

  deps.logger.log("[worker] Poll phase: reconcile review pids");
  const reviewMap = deps.readReviewSummaryMap();
  const liveReviewKeys = new Set<string>();
  for (const review of Object.values(reviewMap)) {
    if (!review.current_run_pid) {
      activeReviewPids.delete(review.pr_url);
      if (review.current_run_id != null) {
        const cleared = await mutateStoredReview(
          deps,
          review.pr_url,
          (current) => {
            if (
              !current ||
              current.current_run_pid != null ||
              current.current_run_id !== review.current_run_id
            ) {
              return undefined;
            }
            return { ...current, current_run_id: undefined };
          }
        );
        if (cleared) {
          deps.logger.log(
            `[worker] Cleared orphaned review run ID for ${review.pr_url}`
          );
        }
      }
      continue;
    }
    try {
      if (!deps.isPidRunning(review.current_run_pid)) {
        throw new Error("process not running");
      }
      activeReviewPids.set(review.pr_url, review.current_run_pid);
      liveReviewKeys.add(review.pr_url);
    } catch {
      const cleared = deps.clearReviewRunIfMatching
        ? await deps.clearReviewRunIfMatching(
            review.pr_url,
            review.current_run_pid,
            review.current_run_id
          )
        : await deps.upsertReviewSummary({
            ...review,
            current_run_pid: undefined,
            current_run_id: undefined,
          });
      if (cleared) {
        deps.logger.log(
          `[worker] Cleared orphaned review PID ${review.current_run_pid} for ${review.pr_url}`
        );
        activeReviewPids.delete(review.pr_url);
      } else {
        // Completion or a newer run won the store race. Re-read instead of
        // clearing that newer owner's state from the worker-local map.
        const latest = deps.readReviewSummaryMap()[review.pr_url];
        let latestIsLive = false;
        try {
          latestIsLive = Boolean(
            latest?.current_run_pid &&
              deps.isPidRunning(latest.current_run_pid)
          );
        } catch {}
        if (latest?.current_run_pid && latestIsLive) {
          activeReviewPids.set(review.pr_url, latest.current_run_pid);
          liveReviewKeys.add(review.pr_url);
        } else {
          activeReviewPids.delete(review.pr_url);
        }
      }
    }
  }
  for (const prUrl of [...activeReviewPids.keys()]) {
    if (!liveReviewKeys.has(prUrl)) {
      activeReviewPids.delete(prUrl);
    }
  }

  deps.logger.log("[worker] Poll phase: scan review requests");
  let inboundReviewRequests: ReviewRequest[] = [];
  let inboundFetchFailed = false;
  try {
    inboundReviewRequests = await deps.getReviewRequestedPRs();
  } catch (error) {
    deps.logger.error("[worker] Failed to fetch review-requested PRs:", error);
    inboundFetchFailed = true;
  }

  const requestsByUrl = new Map<string, ReviewRequest>();
  const schedulableTaskUrls = new Set(
    taskReviewRequests.map((request) => request.pr_url)
  );
  const refreshOnlyTaskUrls = new Set(
    refreshOnlyTaskReviewRequests
      .map((request) => request.pr_url)
      .filter((prUrl) => !schedulableTaskUrls.has(prUrl))
  );
  const inboundRequestsByUrl = new Map(
    inboundReviewRequests.map((request) => [request.pr_url, request] as const)
  );
  for (const request of inboundReviewRequests) {
    // A live Cortex task owns its PR even while paused, opted out, or running
    // its builder. Do not let the inbound discovery path bypass those task
    // scheduling guards for the same URL.
    if (
      liveTaskPrUrls.has(request.pr_url) &&
      !schedulableTaskUrls.has(request.pr_url)
    ) {
      continue;
    }
    requestsByUrl.set(request.pr_url, {
      ...request,
      source: request.source || "inbound",
    });
  }
  // A Cortex task is the authoritative source when a URL somehow appears in
  // both inputs: task context and builder coordination must not be lost.
  for (const request of taskReviewRequests) {
    requestsByUrl.set(request.pr_url, { ...request, source: "task" });
  }
  for (const request of refreshOnlyTaskReviewRequests) {
    if (!schedulableTaskUrls.has(request.pr_url)) {
      requestsByUrl.set(request.pr_url, { ...request, source: "task" });
    }
  }
  const ownershipOnlyTaskUrls = new Set<string>();
  const cachedBeforeOwnership = deps.readReviewSummaryMap();
  for (const [prUrl, taskSnapshot] of liveTaskOwners) {
    if (schedulableTaskUrls.has(prUrl) || refreshOnlyTaskUrls.has(prUrl)) {
      continue;
    }
    const cached = cachedBeforeOwnership[prUrl];
    if (!cached || cached.source === "task") continue;
    const task = await deps.getTask(taskSnapshot.id);
    if (
      !task ||
      task.status !== "in_review" ||
      typeof task.pr_url !== "string" ||
      task.pr_url !== prUrl
    ) {
      continue;
    }
    const request = taskReviewRequest(
      { ...task, pr_url: task.pr_url },
      inboundRequestsByUrl.get(prUrl)?.head_sha || cached.head_sha
    );
    if (!request) continue;
    // The live task owns this URL even when its scheduling guards prevent a
    // review run. Reconcile the cached inbound row into task context so it is
    // neither actionable in the inbound UI nor eligible for owner decisions.
    requestsByUrl.set(prUrl, request);
    ownershipOnlyTaskUrls.add(prUrl);
  }
  const openReviewRequests = [...requestsByUrl.values()];

  for (const pr of openReviewRequests) {
    await mutateStoredReview(deps, pr.pr_url, (current) => {
      if (
        refreshOnlyTaskUrls.has(pr.pr_url) &&
        (!current ||
          current.source !== "task" ||
          current.task_id !== pr.task_id)
      ) {
        return undefined;
      }
      if (!current) {
        return {
          ...prFieldsFromRequest(pr),
          summary: "",
          generated_at: "",
        };
      }
      const reviewContextChanged =
        (current.source || "inbound") !== (pr.source || "inbound") ||
        current.self_authored !== pr.self_authored ||
        current.task_id !== pr.task_id ||
        current.task_title !== pr.task_title ||
        current.task_description !== pr.task_description ||
        current.task_plan !== pr.task_plan;
      if (current.head_sha !== pr.head_sha) {
        return {
          ...current,
          ...prFieldsFromRequest(pr),
          summary: reviewContextChanged ? "" : current.summary,
          summary_head_sha: reviewContextChanged
            ? undefined
            : summaryHeadShaFor(current),
          generated_at: reviewContextChanged ? "" : current.generated_at,
          session_id: reviewContextChanged ? undefined : current.session_id,
          session_profile: reviewContextChanged
            ? undefined
            : current.session_profile,
          agent_review_status: undefined,
          error: undefined,
          error_at: undefined,
          followups: reviewContextChanged ? [] : current.followups,
          final_at: undefined,
          final_state_lookup_started_at: undefined,
          final_state_lookup_error_started_at: undefined,
          final_state_lookup_error: undefined,
        };
      }

      const wasFinal = Boolean(current.final_at);
      const hadFinalLookup = Boolean(
        current.final_state_lookup_started_at || current.final_state_lookup_error
      );
      const reviewShaChanged =
        current.my_last_review_sha !== pr.my_last_review_sha ||
        current.my_approval_sha !== pr.my_approval_sha ||
        current.my_changes_requested_sha !== pr.my_changes_requested_sha;
      const sourceMetadataChanged =
        reviewContextChanged ||
        current.label_only !== pr.label_only ||
        current.title !== pr.title ||
        current.updated_at !== pr.updated_at;
      if (!wasFinal && !reviewShaChanged && !sourceMetadataChanged && !hadFinalLookup) {
        return undefined;
      }
      // An approval going set -> undefined means the human requested changes
      // or dismissed their approval. It supersedes a stale agent verdict.
      const approvalWithdrawn =
        Boolean(current.my_approval_sha) && !pr.my_approval_sha;
      return {
        ...current,
        ...prFieldsFromRequest(pr),
        summary: reviewContextChanged ? "" : current.summary,
        summary_head_sha: reviewContextChanged
          ? undefined
          : current.summary_head_sha,
        generated_at: reviewContextChanged ? "" : current.generated_at,
        session_id: reviewContextChanged ? undefined : current.session_id,
        session_profile: reviewContextChanged
          ? undefined
          : current.session_profile,
        error: reviewContextChanged ? undefined : current.error,
        error_at: reviewContextChanged ? undefined : current.error_at,
        followups: reviewContextChanged ? [] : current.followups,
        agent_review_status: approvalWithdrawn || reviewContextChanged
          ? undefined
          : current.agent_review_status,
        final_at: undefined,
        final_state: undefined,
        final_state_lookup_started_at: undefined,
        final_state_lookup_error_started_at: undefined,
        final_state_lookup_error: undefined,
      };
    });
  }

  const maxParallelReviews = Math.max(1, config.max_parallel_reviews ?? 2);
  let reviewSlots = maxParallelReviews - activeReviewPids.size;
  if (reviewSlots > 0) {
    for (const pr of openReviewRequests) {
      if (
        refreshOnlyTaskUrls.has(pr.pr_url) ||
        ownershipOnlyTaskUrls.has(pr.pr_url)
      ) {
        continue;
      }
      if (reviewSlots <= 0) break;
      if (activeReviewPids.has(pr.pr_url)) continue;
      if (pr.source === "task" && pr.task_id) {
        const task = await deps.getTask(pr.task_id);
        if (
          !task ||
          task.paused ||
          task.status !== "in_review" ||
          task.pr_url !== pr.pr_url ||
          task.current_run_pid != null ||
          !isAutomaticReviewEnabled(task)
        ) {
          continue;
        }
      }
      const cached = deps.readReviewSummaryMap()[pr.pr_url];
      if (
        cached?.current_run_pid != null ||
        cached?.current_run_id != null
      ) {
        continue;
      }
      const needsSummary =
        !cached ||
        Boolean(cached.error) ||
        !cached.summary ||
        summaryHeadShaFor(cached) !== cached.head_sha;
      if (
        !needsSummary ||
        (cached.error && !shouldRetryErroredReview(cached, config))
      ) {
        continue;
      }
      try {
        const { pid, done } = await deps.spawnReviewSummary(
          pr,
          {},
          async (summary) => {
            activeReviewPids.delete(pr.pr_url);
            if (
              summary.source === "task" &&
              summary.task_id &&
              summary.agent_review_status === "needs_author_changes" &&
              summary.summary_head_sha === summary.head_sha
            ) {
              const task = await deps.getTask(summary.task_id);
              if (
                task &&
                !task.paused &&
                task.status === "in_review" &&
                task.pr_url === summary.pr_url &&
                isAutomaticReviewEnabled(task)
              ) {
                await deps.updateTask(task.id, {
                  resume_requested: true,
                  resume_run_mode: "review",
                });
              }
            }
          }
        );
        void done.catch((error) => {
          if (activeReviewPids.get(pr.pr_url) === pid) {
            activeReviewPids.delete(pr.pr_url);
          }
          deps.logger.error(
            `[worker] Review summary run failed for ${pr.pr_url}:`,
            error
          );
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

  deps.logger.log("[worker] Poll phase: finalize completed reviews");
  const openSet = new Set(openReviewRequests.map((r) => r.pr_url));
  for (const prUrl of liveTaskPrUrls) openSet.add(prUrl);
  if (inboundFetchFailed) {
    for (const review of Object.values(deps.readReviewSummaryMap())) {
      if ((review.source || "inbound") === "inbound" && !review.final_at) {
        openSet.add(review.pr_url);
      }
    }
  }
  const reviewsForFinalization: ReviewSummary[] = Object.values(
    deps.readReviewSummaryMap()
  );
  for (const review of reviewsForFinalization) {
    if (activeReviewPids.has(review.pr_url)) continue;
    if (review.final_at || openSet.has(review.pr_url)) continue;
    let finalState: "merged" | "closed" | null = null;
    let lookupError: unknown;
    try {
      finalState = await deps.isPRMergedOrClosed(review.pr_url);
    } catch (error) {
      lookupError = error;
      deps.logger.error(
        `[worker] Failed to classify final review ${review.pr_url}:`,
        error
      );
    }
    if (!finalState) {
      if (!lookupError && review.label_only) {
        const now = new Date().toISOString();
        await mutateStoredReview(deps, review.pr_url, (current) => {
          if (
            !current ||
            !current.label_only ||
            current.final_at ||
            current.current_run_pid != null ||
            current.current_run_id != null
          ) {
            return undefined;
          }
          return {
            ...current,
            final_at: now,
            final_state: undefined,
            final_state_lookup_started_at: undefined,
            final_state_lookup_error_started_at: undefined,
            final_state_lookup_error: undefined,
          };
        });
        continue;
      }
      const now = Date.now();
      const lookupMessage = lookupError
        ? errorMessage(lookupError)
        : "GitHub did not return merged or closed state.";
      await mutateStoredReview(deps, review.pr_url, (current) => {
        if (
          !current ||
          current.final_at ||
          current.current_run_pid != null ||
          current.current_run_id != null
        ) {
          return undefined;
        }
        const lookupStartedAt =
          current.final_state_lookup_started_at || new Date(now).toISOString();
        const errorStartedAt = lookupError
          ? current.final_state_lookup_error_started_at ||
            new Date(now).toISOString()
          : undefined;
        const errorStartedMs = errorStartedAt
          ? new Date(errorStartedAt).getTime()
          : NaN;
        const retryExpired =
          Boolean(lookupError) &&
          Number.isFinite(errorStartedMs) &&
          now - errorStartedMs >= FINAL_CLASSIFICATION_RETRY_MS;
        return {
          ...current,
          final_at: retryExpired ? new Date(now).toISOString() : undefined,
          final_state_lookup_started_at: retryExpired
            ? undefined
            : lookupStartedAt,
          final_state_lookup_error_started_at: retryExpired
            ? undefined
            : errorStartedAt,
          final_state_lookup_error: retryExpired
            ? `Final-state lookup timed out after ${Math.round(
                FINAL_CLASSIFICATION_RETRY_MS / 60000
              )} minutes: ${lookupMessage}`
            : lookupMessage,
        };
      });
      continue;
    }
    await mutateStoredReview(deps, review.pr_url, (current) => {
      if (
        !current ||
        current.final_at ||
        current.current_run_pid != null ||
        current.current_run_id != null
      ) {
        return undefined;
      }
      return {
        ...current,
        final_at: new Date().toISOString(),
        final_state: finalState,
        final_state_lookup_started_at: undefined,
        final_state_lookup_error_started_at: undefined,
        final_state_lookup_error: undefined,
        retro_status:
          finalState === "merged" &&
          learningEnabled &&
          current.retro_status == null &&
          current.summary?.trim()
            ? "pending"
            : current.retro_status,
      };
    });
  }

  deps.logger.log("[worker] Poll phase: run review retros");
  const reviewsForRetroReconcile: ReviewSummary[] = Object.values(
    deps.readReviewSummaryMap()
  );
  if (activeRetroPid != null) {
    const tracked = reviewsForRetroReconcile.some(
      (review) => review.retro_run_pid === activeRetroPid
    );
    if (!tracked) {
      activeRetroPid = undefined;
    }
  }

  for (const review of reviewsForRetroReconcile) {
    if (review.retro_run_pid == null) continue;
    const retroPid = review.retro_run_pid;
    let retroRunning = false;
    try {
      retroRunning = deps.isPidRunning(retroPid);
    } catch {
      retroRunning = false;
    }

    if (retroRunning) {
      activeRetroPid ??= retroPid;
      continue;
    }

    if (activeRetroPid === retroPid) {
      activeRetroPid = undefined;
    }
    await mutateStoredReview(deps, review.pr_url, (current) => {
      if (!current || current.retro_run_pid !== retroPid) return undefined;
      return {
        ...current,
        retro_status:
          current.retro_status === "pending" ? "error" : current.retro_status,
        retro_error:
          current.retro_status === "pending"
            ? "Retro process exited before completion."
            : current.retro_error,
        retro_run_pid: undefined,
      };
    });
  }

  if (activeRetroPid != null) {
    try {
      if (!deps.isPidRunning(activeRetroPid)) {
        activeRetroPid = undefined;
      }
    } catch {
      activeRetroPid = undefined;
    }
  }

  if (learningEnabled && activeRetroPid == null) {
    const pending = Object.values(deps.readReviewSummaryMap())
      .filter((review) => {
        return review.retro_status === "pending" && review.retro_run_pid == null;
      })
      .sort((a, b) => (a.final_at ?? "").localeCompare(b.final_at ?? ""));
    const next = pending[0];
    if (next) {
      try {
        const learningsBefore = deps.readReviewLearnings();
        const retroLaunch: { completed: boolean; pid?: number } = {
          completed: false,
        };
        const { pid } = await deps.spawnReviewRetro(next, learningsBefore, () => {
          retroLaunch.completed = true;
          if (retroLaunch.pid == null || activeRetroPid === retroLaunch.pid) {
            activeRetroPid = undefined;
          }
        });
        retroLaunch.pid = pid;
        if (!retroLaunch.completed) {
          activeRetroPid = pid;
        }
        deps.logger.log(`[worker] Spawned review retro for ${next.pr_url}`);
      } catch (error) {
        deps.logger.error(
          `[worker] Failed to spawn review retro for ${next.pr_url}:`,
          error
        );
      }
    }
  }

  deps.logger.log("[worker] Poll phase: cleanup final review workspaces");
  const blockedWorkspaceCleanup = new Set<string>();
  const reviewsForWorkspaceCleanup: ReviewSummary[] = Object.values(
    deps.readReviewSummaryMap()
  );
  for (const review of reviewsForWorkspaceCleanup) {
    if (
      !shouldCleanupFinalReviewWorkspace(
        review,
        learningEnabled,
        activeReviewPids.has(review.pr_url)
      )
    ) {
      continue;
    }
    const removed = await deps.removeFinalReviewWorkspace(review.pr_url);
    if (!removed) {
      blockedWorkspaceCleanup.add(review.pr_url);
      deps.logger.error(
        `[worker] Could not safely remove final review workspace for ${review.pr_url}`
      );
    }
  }

  deps.logger.log("[worker] Poll phase: prune old reviews");
  const now = Date.now();
  const reviewsForGC: ReviewSummary[] = Object.values(deps.readReviewSummaryMap());
  for (const review of reviewsForGC) {
    if (blockedWorkspaceCleanup.has(review.pr_url)) continue;
    if (activeReviewPids.has(review.pr_url)) continue;
    if (learningEnabled && review.retro_status === "pending") continue;
    if (review.retro_run_pid != null) {
      try {
        if (deps.isPidRunning(review.retro_run_pid)) continue;
      } catch {
        // Dead retro processes do not block normal review GC.
      }
    }
    if (
      review.final_at &&
      now - new Date(review.final_at).getTime() > PRUNE_AGE_MS
    ) {
      await deleteStoredReviewIf(deps, review.pr_url, (current) => {
        return (
          current.final_at === review.final_at &&
          current.current_run_pid == null &&
          current.current_run_id == null &&
          current.retro_run_pid == null &&
          (!learningEnabled || current.retro_status !== "pending")
        );
      });
    }
  }
}
