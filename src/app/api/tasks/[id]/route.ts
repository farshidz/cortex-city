import { NextRequest, NextResponse } from "next/server";
import { getTask, updateTask, deleteTask, readTasks, readConfig } from "@/lib/store";
import { removeWorktree } from "@/lib/agent-runner";
import { getIssue, unlinkTask } from "@/lib/issue-store";
import { summaryCoversHead } from "@/lib/review-status";
import { getReviewSummary } from "@/lib/review-store";
import type { AgentRuntime, LinkedIssueSummary } from "@/lib/types";
import {
  getDefaultModelForRuntime,
  normalizeEffort,
  normalizeModel,
  normalizePermissionMode,
} from "@/lib/runtime-config";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const allTasks = readTasks();
  const childTasks = allTasks
    .filter((t) => t.parent_task_id === id)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      agent: t.agent,
    }));

  let linked_issue: LinkedIssueSummary | undefined;
  if (task.issue_id) {
    const issue = await getIssue(task.issue_id);
    if (issue) {
      linked_issue = { id: issue.id, title: issue.title, status: issue.status };
    }
  }

  const taskReview = task.pr_url ? getReviewSummary(task.pr_url) : undefined;
  const matchingTaskReview =
    taskReview?.source === "task" && taskReview.task_id === task.id
      ? taskReview
      : undefined;
  const automaticReviewError = matchingTaskReview?.error;
  const automaticReview = matchingTaskReview
    ? {
        state: matchingTaskReview.review_state,
        status: matchingTaskReview.agent_review_status,
        summary: matchingTaskReview.summary?.trim() || undefined,
        generated_at: matchingTaskReview.generated_at || undefined,
        head_sha: matchingTaskReview.head_sha,
        summary_head_sha: matchingTaskReview.summary_head_sha,
        // A rebase that preserved the effective diff moves the head without
        // scheduling another round, so staleness is not a SHA comparison the
        // client can make for itself.
        covers_head: summaryCoversHead(matchingTaskReview),
      }
    : undefined;

  return NextResponse.json({
    ...task,
    child_tasks: childTasks,
    linked_issue,
    automatic_review: automaticReview,
    automatic_review_error: automaticReviewError,
    automatic_review_error_at: automaticReviewError
      ? matchingTaskReview?.error_at
      : undefined,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  try {
    const task = await getTask(id);
    if (!task) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const config = readConfig();
    const runtime: AgentRuntime =
      body.agent_runner || task.agent_runner || config.default_agent_runner;

    if ("agent_runner" in body || "permission_mode" in body) {
      body.permission_mode = normalizePermissionMode(
        runtime,
        body.permission_mode ?? task.permission_mode,
        config.default_permission_mode
      );
    }
    if ("agent_runner" in body || "model" in body) {
      body.model = normalizeModel(
        body.model ?? ("agent_runner" in body ? undefined : task.model),
        getDefaultModelForRuntime(config, runtime)
      );
    }
    if ("agent_runner" in body || "effort" in body) {
      body.effort = normalizeEffort(
        runtime,
        body.effort ?? ("agent_runner" in body ? undefined : task.effort),
        config
      );
    }
    if ("reviewer_agent_enabled" in body) {
      body.reviewer_agent_enabled = body.reviewer_agent_enabled !== false;
    }

    // The implementation worker owns status from its pre-spawn launch marker
    // until it clears the run metadata after final reconciliation. Rejecting
    // external handoffs during that interval prevents the web process from
    // moving the task to in_review while the worker can still publish
    // provisional live PR state.
    if (
      task.status === "in_progress" &&
      (task.current_run_mode != null || task.current_run_pid != null) &&
      "status" in body &&
      body.status !== task.status
    ) {
      return NextResponse.json(
        { error: "Cannot change status while the implementation run is active" },
        { status: 409 }
      );
    }

    const updated = await updateTask(id, body);
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (task.status === "in_progress" && task.current_run_pid) {
    return NextResponse.json(
      { error: "Cannot delete a task with an active session" },
      { status: 409 }
    );
  }
  try {
    if (task.worktree_path) {
      await removeWorktree(task);
    }
    await deleteTask(id);
    if (task.issue_id) {
      const isTerminal = task.status === "merged" || task.status === "closed";
      await unlinkTask(task.issue_id, { keepTerminalStatus: isTerminal }).catch(
        () => {}
      );
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
