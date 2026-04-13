import { NextResponse } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";

export async function GET() {
  const orch = getOrchestrator();
  return NextResponse.json(orch.getStatus());
}
