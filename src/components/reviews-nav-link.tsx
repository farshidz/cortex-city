"use client";

import Link from "next/link";
import useSWR from "swr";
import type { ReviewSummary } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function countReadyActionableReviews(
  reviews: ReviewSummary[] | undefined
): number | undefined {
  return reviews?.filter((r) => {
    if (r.final_at) return false;
    if (!r.summary.trim()) return false;
    if (!r.my_last_review_sha) return true; // not yet reviewed
    return r.my_last_review_sha !== r.head_sha; // new commits since review
  }).length;
}

export function ReviewsNavLink() {
  const { data } = useSWR<ReviewSummary[]>("/api/reviews", fetcher, {
    refreshInterval: 10000,
  });
  // Count ready actionable reviews: open PRs with a generated summary that
  // either have not been reviewed by me or have new commits since my review.
  const count = countReadyActionableReviews(data);

  return (
    <Link
      href="/reviews"
      className="px-2 py-1.5 rounded-md text-sm hover:bg-accent transition-colors flex items-center justify-between"
    >
      <span>Reviews</span>
      {typeof count === "number" && count > 0 && (
        <span className="ml-2 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-yellow-100 text-yellow-800 text-xs font-medium">
          {count}
        </span>
      )}
    </Link>
  );
}
