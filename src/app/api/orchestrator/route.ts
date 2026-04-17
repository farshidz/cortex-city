import { NextResponse } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";

export async function GET() {
  const orch = getOrchestrator();
  return NextResponse.json(orch.getStatus());
}

export async function POST() {
  const orch = getOrchestrator();
  const started = orch.requestPoll();
  return NextResponse.json({
    ok: started,
    status: orch.getStatus(),
  });
}
