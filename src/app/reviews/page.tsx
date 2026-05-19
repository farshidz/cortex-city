"use client";

import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { encodeReviewId } from "@/lib/review-id";
import type { ReviewState, ReviewSummary } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const STATUS_LABEL: Record<ReviewState, string> = {
  needs_approval: "Needs approval",
  approved: "Approved",
  merged_closed: "Merged / closed",
};

function statusBadgeClass(state?: ReviewState): string {
  switch (state) {
    case "approved":
      return "bg-green-100 text-green-800";
    case "merged_closed":
      return "bg-gray-200 text-gray-700";
    case "needs_approval":
    default:
      return "bg-yellow-100 text-yellow-800";
  }
}

function rowClass(review: ReviewSummary): string {
  const isSummarizing =
    review.review_state === "needs_approval" &&
    Boolean(review.current_run_pid) &&
    !review.summary;
  if (isSummarizing) return "animate-pulse-green";
  if (review.review_state === "merged_closed") return "bg-muted/40 opacity-60";
  return "";
}

export default function ReviewsPage() {
  const router = useRouter();
  const { data: reviews } = useSWR<ReviewSummary[]>("/api/reviews", fetcher, {
    refreshInterval: 5000,
  });

  const sorted = reviews
    ? [...reviews].sort((a, b) => {
        const groupDiff =
          stateSortGroup(a.review_state) - stateSortGroup(b.review_state);
        if (groupDiff !== 0) return groupDiff;
        return (
          new Date(b.updated_at || 0).getTime() -
          new Date(a.updated_at || 0).getTime()
        );
      })
    : undefined;

  function openReview(review: ReviewSummary) {
    router.push(`/reviews/${encodeReviewId(review.pr_url)}`);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Reviews</h1>
        <span className="text-sm text-muted-foreground">
          PRs where you are personally a requested reviewer
        </span>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Repo</TableHead>
            <TableHead className="w-[80px]">PR #</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Author</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right w-[80px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted?.map((review) => (
            <TableRow
              key={review.pr_url}
              className={`${rowClass(review)} cursor-pointer`}
              onClick={() => openReview(review)}
            >
              <TableCell className="font-mono text-xs">
                {review.repo_slug}
              </TableCell>
              <TableCell className="font-mono text-xs">
                #{review.pr_number}
              </TableCell>
              <TableCell className="font-medium">
                {review.title || review.pr_url}
              </TableCell>
              <TableCell>
                <Badge variant="outline">{review.author || "—"}</Badge>
              </TableCell>
              <TableCell>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(
                    review.review_state
                  )}`}
                >
                  {STATUS_LABEL[review.review_state ?? "needs_approval"]}
                </span>
              </TableCell>
              <TableCell
                className="text-right"
                onClick={(e) => e.stopPropagation()}
              >
                <a
                  href={review.pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button size="sm" variant="outline">
                    PR
                  </Button>
                </a>
              </TableCell>
            </TableRow>
          ))}
          {(!sorted || sorted.length === 0) && (
            <TableRow>
              <TableCell
                colSpan={6}
                className="text-center text-muted-foreground py-8"
              >
                No review requests right now.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function stateSortGroup(state?: ReviewState): number {
  if (state === "needs_approval") return 0;
  if (state === "approved") return 1;
  return 2;
}
