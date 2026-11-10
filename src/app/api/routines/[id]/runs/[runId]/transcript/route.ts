import { existsSync, readFileSync } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { runTranscriptPath } from "@/lib/routine-store";
import { findRun, notFound } from "@/lib/routine-api";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> }
) {
  const { id, runId } = await params;
  const found = findRun(id, runId);
  if (!found) return notFound("Run not found");
  const file = runTranscriptPath(id, runId);
  const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
  return new NextResponse(text, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}
