import { NextRequest, NextResponse } from "next/server";
import { getTask, updateTask } from "@/lib/store";
import { getOrchestrator } from "@/lib/orchestrator";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (task.status === "merged" || task.status === "closed") {
    return NextResponse.json(
      { error: "Cannot send instructions to a final task" },
      { status: 409 }
    );
  }

  if (task.pending_manual_instruction?.trim()) {
    return NextResponse.json(
      { error: "A manual instruction is already pending" },
      { status: 409 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const instruction =
    typeof body?.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction) {
    return NextResponse.json(
      { error: "instruction is required" },
      { status: 400 }
    );
  }

  const updated = await updateTask(id, {
    pending_manual_instruction: instruction,
  });

  if (!task.current_run_pid) {
    const orchestrator = getOrchestrator();
    orchestrator.requestPoll();
  }

  return NextResponse.json(updated);
}
