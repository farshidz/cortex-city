import type { Task } from "./types";

export function shouldStartFinalCleanup(task: Task, hasActivePid: boolean): boolean {
  return Boolean(
    (task.status === "merged" || task.status === "closed") &&
      task.worktree_path &&
      !hasActivePid &&
      !task.final_cleanup_state
  );
}
