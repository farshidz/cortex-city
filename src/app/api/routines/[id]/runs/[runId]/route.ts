import { NextRequest, NextResponse } from "next/server";
import { updateRun } from "@/lib/routine-store";
import { killProcessTree } from "@/lib/routine-runner";
import { findRun, notFound, readJsonBody } from "@/lib/routine-api";

type Params = { params: Promise<{ id: string; runId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id, runId } = await params;
  const found = findRun(id, runId);
  if (!found) return notFound("Run not found");
  return NextResponse.json({
    run: found.run,
    routine: { id: found.routine.id, name: found.routine.name },
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id, runId } = await params;
  const found = findRun(id, runId);
  if (!found) return notFound("Run not found");
  const body = await readJsonBody(request);
  if (!body) return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });

  if (body.action === "stop") {
    const { run } = found;
    if (run.status !== "running" || !run.pid) {
      return NextResponse.json({ error: "This run isn't running." }, { status: 409 });
    }
    await updateRun(id, runId, { stop_requested: true });
    // The agent runs in its own process group; the worker finalizes the run.
    killProcessTree(run.pid, "SIGTERM");
    return NextResponse.json({ ok: true });
  }

  if (typeof body.kept !== "boolean") {
    return NextResponse.json({ error: "Send {\"kept\": true|false} or {\"action\": \"stop\"}" }, { status: 400 });
  }
  const run = await updateRun(id, runId, { kept: body.kept });
  return NextResponse.json({ run });
}
