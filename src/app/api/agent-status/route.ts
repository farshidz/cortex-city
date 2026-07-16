import { NextResponse } from "next/server";
import { getAgentQuotaStatuses } from "@/lib/agent-status";

export async function GET() {
  return NextResponse.json(await getAgentQuotaStatuses());
}
