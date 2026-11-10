import { NextRequest, NextResponse } from "next/server";
import { deleteRoutine, hasActiveRun, updateRoutine } from "@/lib/routine-store";
import { findRoutine, notFound, readJsonBody, routineDetail, validationErrorResponse } from "@/lib/routine-api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const routine = findRoutine(id);
  if (!routine) return notFound("Routine not found");
  return NextResponse.json(routineDetail(routine));
}

export async function PUT(request: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!findRoutine(id)) return notFound("Routine not found");
  const body = await readJsonBody(request);
  if (!body) return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  try {
    const routine = await updateRoutine(id, body);
    if (!routine) return notFound("Routine not found");
    return NextResponse.json(routineDetail(routine));
  } catch (error) {
    return validationErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!findRoutine(id)) return notFound("Routine not found");
  if (hasActiveRun(id)) {
    return NextResponse.json({ error: "Stop the running run before deleting this routine." }, { status: 409 });
  }
  await deleteRoutine(id);
  return NextResponse.json({ ok: true });
}
