import { NextResponse } from "next/server";
import { readReviewSummaries } from "@/lib/review-store";

export async function GET() {
  const reviews = readReviewSummaries();
  reviews.sort((a, b) => {
    const aTime = new Date(b.updated_at || b.created_at || 0).getTime();
    const bTime = new Date(a.updated_at || a.created_at || 0).getTime();
    return aTime - bTime;
  });
  return NextResponse.json(reviews);
}
