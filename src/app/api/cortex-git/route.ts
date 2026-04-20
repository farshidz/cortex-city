import { NextResponse } from "next/server";
import { getCortexGitStatus } from "@/lib/cortex-git";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getCortexGitStatus());
}
