import { NextRequest, NextResponse } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";
import { requestRoutineRun } from "@/lib/routine-store";
import { findRoutine, notFound } from "@/lib/routine-api";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!findRoutine(id)) return notFound("Routine not found");
  const routine = await requestRoutineRun(id);
  if (!routine) return notFound("Routine not found");
  const worker_notified = getOrchestrator().requestPoll();
  return NextResponse.json({ ok: true, requested_at: routine.run_requested_at, worker_notified });
}
