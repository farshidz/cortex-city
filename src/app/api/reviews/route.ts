import { NextResponse } from "next/server";
import { readReviewSummaries } from "@/lib/review-store";
import { getReviewStatusSortGroup } from "@/lib/review-status";

export async function GET() {
  const reviews = readReviewSummaries();
  reviews.sort((a, b) => {
    const groupDiff =
      getReviewStatusSortGroup(a.review_status) -
      getReviewStatusSortGroup(b.review_status);
    if (groupDiff !== 0) return groupDiff;
    return (
      new Date(b.updated_at || b.created_at || 0).getTime() -
      new Date(a.updated_at || a.created_at || 0).getTime()
    );
  });
  return NextResponse.json(reviews);
}
