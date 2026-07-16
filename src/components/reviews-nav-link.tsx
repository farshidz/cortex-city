"use client";

import useSWR from "swr";
import { SidebarNavLink } from "@/components/sidebar-nav-link";
import type { ReviewSummary } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function countReadyActionableReviews(
  reviews: ReviewSummary[] | undefined
): number | undefined {
  return reviews?.filter(
    (r) =>
      r.source !== "task" &&
      (r.review_state === "blocked" ||
        r.review_state === "needs_author_changes" ||
        r.review_state === "needs_decision" ||
        r.review_state === "ready_to_approve" ||
        r.review_state === "needs_review")
  ).length;
}

export function ReviewsNavLink() {
  const { data } = useSWR<ReviewSummary[]>("/api/reviews", fetcher, {
    refreshInterval: 10000,
  });
  const count = countReadyActionableReviews(data);

  return (
    <SidebarNavLink href="/reviews">
      <span>Reviews</span>
      {typeof count === "number" && count > 0 && (
        <span className="ml-2 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-yellow-100 text-yellow-800 text-xs font-medium">
          {count}
        </span>
      )}
    </SidebarNavLink>
  );
}
