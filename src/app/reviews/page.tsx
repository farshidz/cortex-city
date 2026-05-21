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
import {
  getReviewStatusBadgeClass,
  getReviewStatusLabel,
  getReviewStatusRowClass,
} from "@/lib/review-status-presentation";
import type { ReviewSummary } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ReviewsPage() {
  const router = useRouter();
  const { data: reviews } = useSWR<ReviewSummary[]>("/api/reviews", fetcher, {
    refreshInterval: 5000,
  });

  function openReview(review: ReviewSummary) {
    router.push(`/reviews/${encodeReviewId(review.pr_url)}`);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Reviews</h1>
        <span className="text-sm text-muted-foreground">
          PRs requesting your review or already reviewed by you
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
          {reviews?.map((review) => (
            <TableRow
              key={review.pr_url}
              className={`${getReviewStatusRowClass(review.review_status)} cursor-pointer`}
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
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getReviewStatusBadgeClass(review.review_status)}`}
                >
                  {getReviewStatusLabel(review.review_status)}
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
          {(!reviews || reviews.length === 0) && (
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

      <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-green-500/20 border border-green-500/30 animate-pulse" />
          Summary being generated
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-yellow-500/20 border border-yellow-500/30" />
          Needs your review
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-green-500/20 border border-green-500/30" />
          Up to date
        </span>
      </div>
    </div>
  );
}
