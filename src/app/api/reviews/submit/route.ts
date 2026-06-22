import { NextRequest, NextResponse } from "next/server";
import { submitPRReview } from "@/lib/github";
import { getReviewSummary, patchReviewSummary } from "@/lib/review-store";

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

  // Optimistically reflect the decision in the cached record so the UI updates
  // immediately; the worker reconciles against GitHub on its next poll. We just
  // reviewed the current head, so the review is at head_sha. Approving sets the
  // approval signal (-> "approved" state); any other decision clears it.
  if (decision !== "comment") {
    const cached = getReviewSummary(prUrl);
    if (cached?.head_sha) {
      await patchReviewSummary(prUrl, {
        my_last_review_sha: cached.head_sha,
        my_approval_sha: decision === "approve" ? cached.head_sha : undefined,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
