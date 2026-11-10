import { readFileSync } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { runArtifactsDir } from "@/lib/routine-store";
import { buildZip, resolveStoredArtifact } from "@/lib/routine-artifacts";
import { findRun, notFound } from "@/lib/routine-api";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> }
) {
  const { id, runId } = await params;
  const found = findRun(id, runId);
  if (!found) return notFound("Run not found");
  const files = found.run.artifacts.flatMap((artifact) => {
    const file = resolveStoredArtifact(runArtifactsDir(id, runId), artifact.path);
    return file ? [{ name: artifact.path, data: readFileSync(file) }] : [];
  });
  if (files.length === 0) return notFound("This run has no files");
  const name = `${found.routine.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "routine"}-run-${found.run.number}.zip`;
  return new NextResponse(new Uint8Array(buildZip(files)), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
