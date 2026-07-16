import { NextResponse } from "next/server";
import { readReviewSummaries } from "@/lib/review-store";
import { getReviewStateSortGroup } from "@/lib/review-status";
import { readTasks } from "@/lib/store";

export async function GET() {
  const liveTaskPrUrls = new Set(
    readTasks().flatMap((task) =>
      task.status === "in_review" && typeof task.pr_url === "string"
        ? [task.pr_url]
        : []
    )
  );
  const reviews = readReviewSummaries().filter(
    (review) =>
      review.source !== "task" && !liveTaskPrUrls.has(review.pr_url)
  );
  reviews.sort((a, b) => {
    const groupDiff =
      getReviewStateSortGroup(a.review_state) -
      getReviewStateSortGroup(b.review_state);
    if (groupDiff !== 0) return groupDiff;
    return (
      new Date(b.updated_at || b.created_at || 0).getTime() -
      new Date(a.updated_at || a.created_at || 0).getTime()
    );
  });
  return NextResponse.json(reviews);
}
