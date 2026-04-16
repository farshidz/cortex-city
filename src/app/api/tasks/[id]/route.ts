import { NextRequest, NextResponse } from "next/server";
import { getTask, updateTask, deleteTask, readTasks, readConfig } from "@/lib/store";
import { removeWorktree } from "@/lib/agent-runner";
import type { AgentRuntime } from "@/lib/types";
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

  return NextResponse.json({ ...task, child_tasks: childTasks });
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

    // If transitioning to a final status, clean up the worktree
    if (body.status === "merged" || body.status === "closed") {
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
