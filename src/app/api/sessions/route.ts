import { NextRequest, NextResponse } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";

export async function GET() {
  const orch = getOrchestrator();
  const sessions = orch.getActiveSessions();
  return NextResponse.json(sessions);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (!body.task_id) {
    return NextResponse.json({ error: "task_id required" }, { status: 400 });
  }
  const orch = getOrchestrator();
  const killed = orch.killSession(body.task_id);
  if (!killed) {
    return NextResponse.json(
      { error: "No active session for this task" },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true });
}
