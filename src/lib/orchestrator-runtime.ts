import type { ResumableTaskRunMode, Task } from "./types";

function isResumableStatus(task: Task): boolean {
  return task.status === "open" || task.status === "in_progress" || task.status === "in_review";
}

export function buildInterruptedTaskUpdates(task: Task): Partial<Task> {
  const updates: Partial<Task> = {
    current_run_pid: undefined,
    current_run_mode: undefined,
  };

  if (isResumableStatus(task)) {
    updates.resume_requested = true;
    if (task.current_run_mode && task.current_run_mode !== "cleanup") {
      updates.resume_run_mode = task.current_run_mode as ResumableTaskRunMode;
    }
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

export function isReviewerAgentEnabled(
  task: Pick<Task, "reviewer_agent_enabled">
): boolean {
  return task.reviewer_agent_enabled !== false;
}

export function getTaskRunMode(task: Task): ResumableTaskRunMode {
  if (task.resume_run_mode) return task.resume_run_mode;
  return task.status === "in_review" ? "review" : "initial";
}

export function shouldUseContinuePrompt(
  task: Task,
  mode: ResumableTaskRunMode = getTaskRunMode(task)
): boolean {
  const sessionId =
    mode === "reviewer" ? task.reviewer_session_id : task.session_id;
  return Boolean(task.resume_requested && sessionId);
}
