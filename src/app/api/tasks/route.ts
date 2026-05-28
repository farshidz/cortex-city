import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { readTasks, createTask, deleteTask, readConfig } from "@/lib/store";
import { getIssue, linkTask } from "@/lib/issue-store";
import type { AgentRuntime, Task } from "@/lib/types";
import { getOrchestrator } from "@/lib/orchestrator";
import {
  getDefaultModelForRuntime,
  normalizeEffort,
  normalizeModel,
  normalizePermissionMode,
} from "@/lib/runtime-config";

export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status");
  let tasks = readTasks();
  if (status) {
    tasks = tasks.filter((t) => t.status === status);
  }
  return NextResponse.json(tasks);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const now = new Date().toISOString();
  const config = readConfig();
  const runtime: AgentRuntime = body.agent_runner || config.default_agent_runner;

  const issueId: string | undefined =
    typeof body.issue_id === "string" && body.issue_id ? body.issue_id : undefined;
  if (issueId) {
    const issue = await getIssue(issueId);
    if (!issue) {
      return NextResponse.json({ error: "Issue not found" }, { status: 400 });
    }
    if (issue.task_id) {
      return NextResponse.json(
        { error: "Issue is already linked to a task" },
        { status: 409 }
      );
    }
  }

  const task: Task = {
    id: nanoid(10),
    title: body.title,
    description: body.description,
    plan: body.plan || undefined,
    status: "open",
    agent: body.agent,
    agent_runner: runtime,
    reviewer_agent_enabled: body.reviewer_agent_enabled !== false,
    permission_mode: normalizePermissionMode(
      runtime,
      body.permission_mode,
      config.default_permission_mode
    ),
    model: normalizeModel(body.model, getDefaultModelForRuntime(config, runtime)),
    effort: normalizeEffort(runtime, body.effort, config),
    branch_name: body.branch_name || undefined,
    created_at: now,
    updated_at: now,
    run_count: 0,
    total_input_tokens: 0,
    total_cached_input_tokens: 0,
    total_output_tokens: 0,
    issue_id: issueId,
  };
  await createTask(task);

  if (issueId) {
    try {
      await linkTask(issueId, task.id);
    } catch (error) {
      await deleteTask(task.id).catch(() => {});
      const message = error instanceof Error ? error.message : "Failed to link issue";
      return NextResponse.json({ error: message }, { status: 409 });
    }
  }

  const orchestrator = getOrchestrator();
  orchestrator.requestPoll();
  return NextResponse.json(task, { status: 201 });
}
