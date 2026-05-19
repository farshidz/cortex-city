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
import type { ReviewSummary } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type RowState = "unchanged" | "new_commits";

function rowState(review: ReviewSummary): RowState {
  if (!review.my_last_review_sha) return "unchanged"; // never reviewed
  return review.my_last_review_sha === review.head_sha
    ? "unchanged"
    : "new_commits";
}

function statusLabel(review: ReviewSummary): string {
  if (!review.my_last_review_sha) return "Awaiting your review";
  return review.my_last_review_sha === review.head_sha
    ? "Up to date with your review"
    : "New commits since your review";
}

function statusBadgeClass(state: RowState): string {
  return state === "new_commits"
    ? "bg-yellow-100 text-yellow-800"
    : "bg-blue-100 text-blue-800";
}

function rowClass(review: ReviewSummary): string {
  const isSummarizing =
    !review.summary && Boolean(review.current_run_pid);
  if (isSummarizing) return "animate-pulse-green";
  return rowState(review) === "new_commits"
    ? "bg-yellow-500/10"
    : "bg-blue-500/10";
}

export default function ReviewsPage() {
  const router = useRouter();
  const { data: reviews } = useSWR<ReviewSummary[]>("/api/reviews", fetcher, {
    refreshInterval: 5000,
  });

  // Hide entries that have dropped from the open review-requested list
  // (still in the 24h GC window).
  const visible = reviews?.filter((r) => !r.final_at);
  const sorted = visible
    ? [...visible].sort((a, b) => {
        const groupDiff = stateSortGroup(a) - stateSortGroup(b);
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
          {sorted?.map((review) => {
            const state = rowState(review);
            return (
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
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(state)}`}
                  >
                    {statusLabel(review)}
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
            );
          })}
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

      <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-green-500/20 border border-green-500/30 animate-pulse" />
          Summary being generated
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-yellow-500/20 border border-yellow-500/30" />
          New commits since your review
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-blue-500/20 border border-blue-500/30" />
          Awaiting your review / up to date
        </span>
      </div>
    </div>
  );
}

function stateSortGroup(review: ReviewSummary): number {
  return rowState(review) === "new_commits" ? 0 : 1;
}
