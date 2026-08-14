import type { Task } from "./types";

export function isFinalTask(task: Pick<Task, "status">): boolean {
  return task.status === "merged" || task.status === "closed";
}

export function shouldClearMissingFinalWorktreePath(
  task: Task,
  hasActivePid: boolean,
  hasClearableWorktreePath: boolean
): boolean {
  return Boolean(
    isFinalTask(task) &&
      task.worktree_path &&
      !hasActivePid &&
      hasClearableWorktreePath
  );
}

export function shouldStartFinalCleanup(
  task: Task,
  hasActivePid: boolean,
  hasWorktreeDirectory = Boolean(task.worktree_path)
): boolean {
  return Boolean(
    isFinalTask(task) &&
      task.worktree_path &&
      hasWorktreeDirectory &&
      !hasActivePid &&
      !task.final_cleanup_state
  );
}
