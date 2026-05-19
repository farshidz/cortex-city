"use client";

import Link from "next/link";
import useSWR from "swr";
import type { ReviewSummary } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function ReviewsNavLink() {
  const { data } = useSWR<ReviewSummary[]>("/api/reviews", fetcher, {
    refreshInterval: 10000,
  });
  const count = data?.filter((r) => r.review_state === "needs_approval").length;

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
