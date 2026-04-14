import { NextRequest, NextResponse } from "next/server";
import { getTask, updateTask, deleteTask } from "@/lib/store";
import { removeWorktree } from "@/lib/agent-runner";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(task);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  try {
    // If transitioning to a final status, clean up the worktree
    if (body.status === "merged" || body.status === "closed") {
      const task = await getTask(id);
      if (task?.worktree_path) {
        removeWorktree(task);
        body.worktree_path = undefined;
      }
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
      removeWorktree(task);
    }
    await deleteTask(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
