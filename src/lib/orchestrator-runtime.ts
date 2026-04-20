import type { Task } from "./types";

function isResumableStatus(task: Task): boolean {
  return task.status === "open" || task.status === "in_progress" || task.status === "in_review";
}

export function buildInterruptedTaskUpdates(task: Task): Partial<Task> {
  const updates: Partial<Task> = {
    current_run_pid: undefined,
  };

  if (isResumableStatus(task)) {
    updates.resume_requested = true;
  } else if (task.final_cleanup_state === "running") {
    updates.final_cleanup_state = undefined;
  }

  return updates;
}

export function shouldResumeTask(task: Task): boolean {
  return (
    !task.current_run_pid &&
    Boolean(task.resume_requested || task.pending_manual_instruction) &&
    isResumableStatus(task)
  );
}

export function getTaskRunMode(task: Task): "initial" | "review" {
  return task.status === "in_review" ? "review" : "initial";
}

export function shouldUseContinuePrompt(task: Task): boolean {
  return Boolean(task.resume_requested && task.session_id);
}
