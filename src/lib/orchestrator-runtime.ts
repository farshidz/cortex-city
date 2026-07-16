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
    const currentMode = task.current_run_mode as string | undefined;
    if (currentMode === "reviewer") {
      // Legacy task-reviewer processes must never turn into builder resumes.
      // The unified reviewer will independently pick up the task PR.
      updates.resume_requested = undefined;
      updates.resume_run_mode = undefined;
    } else {
      updates.resume_requested = true;
      if (currentMode === "initial" || currentMode === "review") {
        updates.resume_run_mode = currentMode;
      }
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

export function getTaskRunMode(task: Task): ResumableTaskRunMode {
  if (task.resume_run_mode === "initial" || task.resume_run_mode === "review") {
    return task.resume_run_mode;
  }
  return task.status === "in_review" ? "review" : "initial";
}

export function shouldUseContinuePrompt(
  task: Task,
  mode: ResumableTaskRunMode = getTaskRunMode(task)
): boolean {
  // Review-mode resumes need the current PR-feedback prompt, including fresh
  // GitHub state. A bare "continue" is reserved for interrupted implementation
  // work where the existing session already owns the next step.
  return mode !== "review" && Boolean(task.resume_requested && task.session_id);
}
