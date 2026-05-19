import { NextRequest, NextResponse } from "next/server";
import { submitPRReview } from "@/lib/github";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const prUrl = typeof body?.pr_url === "string" ? body.pr_url.trim() : "";
  const decision = body?.decision;
  const reviewBody = typeof body?.body === "string" ? body.body : "";

  if (!prUrl) {
    return NextResponse.json({ error: "pr_url is required" }, { status: 400 });
  }
  if (
    decision !== "approve" &&
    decision !== "request-changes" &&
    decision !== "comment"
  ) {
    return NextResponse.json(
      { error: "decision must be approve, request-changes, or comment" },
      { status: 400 }
    );
  }

  const result = await submitPRReview(prUrl, decision, reviewBody);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
