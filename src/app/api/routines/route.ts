import { NextRequest, NextResponse } from "next/server";
import { createRoutine, listRoutines } from "@/lib/routine-store";
import { readJsonBody, summarizeRoutine, validationErrorResponse } from "@/lib/routine-api";

export async function GET() {
  return NextResponse.json(listRoutines().map(summarizeRoutine));
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody(request);
  if (!body) return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  try {
    const routine = await createRoutine(body);
    return NextResponse.json(summarizeRoutine(routine), { status: 201 });
  } catch (error) {
    return validationErrorResponse(error);
  }
}
