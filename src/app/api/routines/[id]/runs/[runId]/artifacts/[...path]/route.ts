import { readFileSync } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { runArtifactsDir } from "@/lib/routine-store";
import { resolveStoredArtifact } from "@/lib/routine-artifacts";
import { ARTIFACT_CSP, findRun, notFound } from "@/lib/routine-api";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string; path: string[] }> }
) {
  const { id, runId, path: segments } = await params;
  const found = findRun(id, runId);
  if (!found) return notFound("Run not found");
  // Next.js has already decoded each catch-all segment.
  const relative = segments.join("/");
  const artifact = found.run.artifacts.find((entry) => entry.path === relative);
  const file = artifact ? resolveStoredArtifact(runArtifactsDir(id, runId), relative) : undefined;
  if (!artifact || !file) return notFound("Artifact not found");
  const download = request.nextUrl.searchParams.get("download") === "1";
  const filename = path.basename(relative);
  const asciiName = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new NextResponse(new Uint8Array(readFileSync(file)), {
    headers: {
      "Content-Type": artifact.content_type,
      "Content-Security-Policy": ARTIFACT_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
