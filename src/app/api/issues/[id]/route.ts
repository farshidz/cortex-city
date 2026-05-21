import { NextRequest, NextResponse } from "next/server";
import { deleteIssue, getIssue, updateIssue } from "@/lib/issue-store";
import { getTask } from "@/lib/store";
import type { IssueStatus, LinkedTaskSummary } from "@/lib/types";

const ALLOWED_STATUSES: IssueStatus[] = ["open", "in_progress", "done", "closed"];

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const issue = await getIssue(id);
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let linked_task: LinkedTaskSummary | undefined;
  if (issue.task_id) {
    const task = await getTask(issue.task_id);
    if (task) {
      linked_task = { id: task.id, title: task.title, status: task.status };
    }
  }
  return NextResponse.json({ ...issue, linked_task });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const updates: {
    title?: string;
    description?: string;
    plan?: string;
    status?: IssueStatus;
  } = {};
  if (typeof body.title === "string") updates.title = body.title;
  if (typeof body.description === "string") updates.description = body.description;
  if (typeof body.plan === "string") updates.plan = body.plan;
  if (typeof body.status === "string") {
    if (!ALLOWED_STATUSES.includes(body.status as IssueStatus)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    updates.status = body.status as IssueStatus;
  }
  try {
    const updated = await updateIssue(id, updates);
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
  const issue = await getIssue(id);
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (issue.task_id) {
    return NextResponse.json(
      { error: "Delete or unlink the linked task before deleting this issue" },
      { status: 409 }
    );
  }
  try {
    await deleteIssue(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
