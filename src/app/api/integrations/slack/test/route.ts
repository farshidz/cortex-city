import { NextRequest, NextResponse } from "next/server";
import { sendSlackTestMessage } from "@/lib/slack";
import { readJsonBody, validationErrorResponse } from "@/lib/routine-api";

/** Sends a test DM from the connected bot to the given email or member ID. */
export async function POST(request: NextRequest) {
  const body = await readJsonBody(request);
  if (!body || typeof body.target !== "string" || !body.target.trim()) {
    return NextResponse.json(
      { error: "Send {\"target\": \"you@example.com\"} or a Slack member ID" },
      { status: 400 }
    );
  }
  try {
    return NextResponse.json({ ok: true, ...(await sendSlackTestMessage(body.target)) });
  } catch (error) {
    return validationErrorResponse(error);
  }
}
