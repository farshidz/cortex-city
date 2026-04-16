import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { readTasks, createTask, readConfig } from "@/lib/store";
import type { AgentRuntime, Task } from "@/lib/types";
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
  const task: Task = {
    id: nanoid(10),
    title: body.title,
    description: body.description,
    plan: body.plan || undefined,
    status: "open",
    agent: body.agent,
    agent_runner: runtime,
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
    total_output_tokens: 0,
  };
  await createTask(task);
  return NextResponse.json(task, { status: 201 });
}
