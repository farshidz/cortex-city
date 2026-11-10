import { NextRequest, NextResponse } from "next/server";
import { connectSlack, disconnectSlack, getSlackConnection } from "@/lib/slack";
import { readJsonBody, validationErrorResponse } from "@/lib/routine-api";

export async function GET() {
  return NextResponse.json(getSlackConnection());
}

export async function PUT(request: NextRequest) {
  const body = await readJsonBody(request);
  if (!body || typeof body.token !== "string") {
    return NextResponse.json({ error: "Send {\"token\": \"xoxb-…\"}" }, { status: 400 });
  }
  try {
    return NextResponse.json(await connectSlack(body.token));
  } catch (error) {
    return validationErrorResponse(error);
  }
}

export async function DELETE() {
  await disconnectSlack();
  return NextResponse.json(getSlackConnection());
}
