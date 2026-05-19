import { NextRequest, NextResponse } from "next/server";
import { appendFollowup, askFollowup } from "@/lib/review-runner";
import { getReviewSummary } from "@/lib/review-store";

export async function GET(request: NextRequest) {
  const prUrl = request.nextUrl.searchParams.get("pr_url")?.trim() || "";
  if (!prUrl) {
    return NextResponse.json({ error: "pr_url is required" }, { status: 400 });
  }
  const summary = getReviewSummary(prUrl);
  if (!summary) {
    return NextResponse.json({ followups: [] });
  }
  return NextResponse.json({ followups: summary.followups || [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const prUrl = typeof body?.pr_url === "string" ? body.pr_url.trim() : "";
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!prUrl) {
    return NextResponse.json({ error: "pr_url is required" }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  try {
    const followup = await askFollowup(prUrl, question);
    await appendFollowup(prUrl, followup);
    return NextResponse.json(followup);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
