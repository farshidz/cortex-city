"use client";

import { Fragment, useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { getEffortOptions } from "@/lib/runtime-config";
import type {
  AgentRuntime,
  OrchestratorConfig,
  PRStatus,
  ReviewFollowup,
  ReviewSummary,
  TaskEffort,
} from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const PR_STATUS_LABEL: Record<PRStatus, string> = {
  clean: "Clean",
  checks_failing: "Checks failing",
  checks_pending: "Checks pending",
  needs_approval: "Needs approval",
  conflicts: "Conflicts",
  unstable: "Unstable",
  unknown: "Unknown",
};

function statusBadgeClass(status?: PRStatus): string {
  switch (status) {
    case "clean":
      return "bg-green-100 text-green-800";
    case "checks_failing":
    case "conflicts":
      return "bg-red-100 text-red-800";
    case "needs_approval":
      return "bg-yellow-100 text-yellow-800";
    case "checks_pending":
      return "bg-blue-100 text-blue-800";
    case "unstable":
      return "bg-orange-100 text-orange-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

function rowClass(review: ReviewSummary): string {
  if (review.current_run_pid) return "animate-pulse-green";
  switch (review.pr_status) {
    case "clean":
      return "bg-green-500/10";
    case "checks_failing":
    case "conflicts":
      return "bg-red-500/10";
    case "needs_approval":
      return "bg-yellow-500/10";
    case "checks_pending":
      return "animate-pulse-blue";
    default:
      return "";
  }
}

interface SubmitDialogState {
  prUrl: string;
  decision: "approve" | "request-changes" | "comment";
  body: string;
  submitting: boolean;
  error?: string;
}

interface RowState {
  expanded: boolean;
  question: string;
  asking: boolean;
  runtimeOverride?: AgentRuntime;
  effortOverride?: TaskEffort;
  regenerating: boolean;
}

export default function ReviewsPage() {
  const { data: reviews, mutate } = useSWR<ReviewSummary[]>(
    "/api/reviews",
    fetcher,
    { refreshInterval: 5000 }
  );
  const { data: config } = useSWR<OrchestratorConfig>("/api/config", fetcher);

  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [submitDialog, setSubmitDialog] = useState<SubmitDialogState | null>(null);

  function updateRowState(prUrl: string, updates: Partial<RowState>) {
    setRowStates((prev) => {
      const base: RowState = prev[prUrl] || {
        expanded: false,
        question: "",
        asking: false,
        regenerating: false,
      };
      return { ...prev, [prUrl]: { ...base, ...updates } };
    });
  }

  function toggleExpanded(prUrl: string) {
    setRowStates((prev) => {
      const current = prev[prUrl] || {
        expanded: false,
        question: "",
        asking: false,
        regenerating: false,
      };
      return { ...prev, [prUrl]: { ...current, expanded: !current.expanded } };
    });
  }

  async function regenerate(review: ReviewSummary) {
    const state = rowStates[review.pr_url];
    updateRowState(review.pr_url, { regenerating: true });
    try {
      await fetch("/api/reviews/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pr_url: review.pr_url,
          runtime: state?.runtimeOverride,
          effort: state?.effortOverride,
        }),
      });
      mutate();
    } finally {
      updateRowState(review.pr_url, { regenerating: false });
    }
  }

  async function askFollowup(review: ReviewSummary) {
    const state = rowStates[review.pr_url];
    const question = state?.question.trim();
    if (!question) return;
    updateRowState(review.pr_url, { asking: true });
    try {
      await fetch("/api/reviews/followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pr_url: review.pr_url, question }),
      });
      updateRowState(review.pr_url, { question: "" });
      mutate();
    } finally {
      updateRowState(review.pr_url, { asking: false });
    }
  }

  async function submitReview() {
    if (!submitDialog) return;
    setSubmitDialog({ ...submitDialog, submitting: true, error: undefined });
    const res = await fetch("/api/reviews/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pr_url: submitDialog.prUrl,
        decision: submitDialog.decision,
        body: submitDialog.body,
      }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      setSubmitDialog({
        ...submitDialog,
        submitting: false,
        error: payload?.error || "Failed to submit review",
      });
      return;
    }
    setSubmitDialog(null);
    mutate();
  }

  const defaultRuntime: AgentRuntime =
    config?.review_runtime || config?.default_agent_runner || "claude";

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Reviews</h1>
        <span className="text-sm text-muted-foreground">
          PRs where you are a requested reviewer
        </span>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Repo</TableHead>
            <TableHead className="w-[80px]">PR #</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Author</TableHead>
            <TableHead>PR status</TableHead>
            <TableHead>Summary</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reviews?.map((review) => {
            const state = rowStates[review.pr_url];
            const expanded = state?.expanded ?? false;
            const runtime = state?.runtimeOverride || defaultRuntime;
            return (
              <Fragment key={review.pr_url}>
                <TableRow className={rowClass(review)}>
                  <TableCell className="font-mono text-xs">
                    {review.repo_slug}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    #{review.pr_number}
                  </TableCell>
                  <TableCell>
                    <a
                      href={review.pr_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline font-medium"
                    >
                      {review.title || review.pr_url}
                    </a>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{review.author || "—"}</Badge>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(
                        review.pr_status
                      )}`}
                    >
                      {PR_STATUS_LABEL[review.pr_status ?? "unknown"]}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-md">
                    {renderSummaryCell(review)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-1 justify-end flex-wrap">
                      <a
                        href={review.pr_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button size="sm" variant="outline">
                          Open
                        </Button>
                      </a>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => regenerate(review)}
                        disabled={Boolean(
                          review.current_run_pid || state?.regenerating
                        )}
                        title="Regenerate summary"
                      >
                        {review.current_run_pid || state?.regenerating
                          ? "…"
                          : "Regen"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => toggleExpanded(review.pr_url)}
                        disabled={!review.summary}
                      >
                        Ask
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setSubmitDialog({
                            prUrl: review.pr_url,
                            decision: "comment",
                            body: "",
                            submitting: false,
                          })
                        }
                      >
                        Review
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                {expanded && (
                  <TableRow>
                    <TableCell colSpan={7} className="bg-muted/30">
                      <div className="space-y-3 p-2">
                        <div className="flex gap-2 items-center">
                          <span className="text-xs text-muted-foreground">
                            Runtime override (fresh runs only):
                          </span>
                          <Select
                            value={state?.runtimeOverride || defaultRuntime}
                            onValueChange={(v) =>
                              updateRowState(review.pr_url, {
                                runtimeOverride: v as AgentRuntime,
                                effortOverride: undefined,
                              })
                            }
                          >
                            <SelectTrigger className="h-7 w-32 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="claude">Claude</SelectItem>
                              <SelectItem value="codex">Codex</SelectItem>
                            </SelectContent>
                          </Select>
                          <Select
                            value={state?.effortOverride || "__default__"}
                            onValueChange={(v) =>
                              updateRowState(review.pr_url, {
                                effortOverride:
                                  v === "__default__"
                                    ? undefined
                                    : (v as TaskEffort),
                              })
                            }
                          >
                            <SelectTrigger className="h-7 w-32 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__default__">
                                Effort: default
                              </SelectItem>
                              {getEffortOptions(runtime).map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="rounded border bg-background p-3 text-sm whitespace-pre-wrap">
                          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                            Summary
                          </div>
                          {review.summary || (
                            <span className="text-muted-foreground italic">
                              No summary yet.
                            </span>
                          )}
                        </div>
                        {(review.followups || []).map((f, idx) => (
                          <FollowupBlock key={idx} followup={f} />
                        ))}
                        <div className="flex flex-col gap-2">
                          <Textarea
                            placeholder="Ask a follow-up question about this summary…"
                            value={state?.question || ""}
                            onChange={(e) =>
                              updateRowState(review.pr_url, {
                                question: e.target.value,
                              })
                            }
                            rows={2}
                          />
                          <div className="flex gap-2 justify-end">
                            <Button
                              size="sm"
                              onClick={() => askFollowup(review)}
                              disabled={
                                state?.asking || !state?.question.trim()
                              }
                            >
                              {state?.asking ? "Asking…" : "Send"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
          {(!reviews || reviews.length === 0) && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                No review requests right now.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {submitDialog && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSubmitDialog(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Submit PR review</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Select
                value={submitDialog.decision}
                onValueChange={(v) =>
                  setSubmitDialog({
                    ...submitDialog,
                    decision: v as SubmitDialogState["decision"],
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="comment">Comment</SelectItem>
                  <SelectItem value="approve">Approve</SelectItem>
                  <SelectItem value="request-changes">
                    Request changes
                  </SelectItem>
                </SelectContent>
              </Select>
              <Textarea
                placeholder={
                  submitDialog.decision === "approve"
                    ? "Optional approval note"
                    : "Review body (required)"
                }
                value={submitDialog.body}
                onChange={(e) =>
                  setSubmitDialog({ ...submitDialog, body: e.target.value })
                }
                rows={6}
              />
              {submitDialog.error && (
                <div className="text-sm text-destructive">
                  {submitDialog.error}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setSubmitDialog(null)}
              >
                Cancel
              </Button>
              <Button onClick={submitReview} disabled={submitDialog.submitting}>
                {submitDialog.submitting ? "Submitting…" : "Submit"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function renderSummaryCell(review: ReviewSummary) {
  if (review.current_run_pid) {
    return (
      <span className="text-muted-foreground italic">Summarizing…</span>
    );
  }
  if (review.error) {
    return <span className="text-destructive text-xs">{review.error}</span>;
  }
  if (!review.summary) {
    return (
      <span className="text-muted-foreground italic">Pending summary…</span>
    );
  }
  const truncated =
    review.summary.length > 220
      ? review.summary.slice(0, 220).trimEnd() + "…"
      : review.summary;
  return <span className="text-sm whitespace-pre-wrap">{truncated}</span>;
}

function FollowupBlock({ followup }: { followup: ReviewFollowup }) {
  return (
    <div className="rounded border bg-background p-3 text-sm space-y-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Question · {new Date(followup.asked_at).toLocaleString()}
      </div>
      <div className="whitespace-pre-wrap">{followup.question}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Answer{" "}
        <span className="lowercase">
          ({followup.resumed ? "resumed session" : "fresh session"})
        </span>
      </div>
      <div className="whitespace-pre-wrap">
        {followup.error ? (
          <span className="text-destructive">{followup.error}</span>
        ) : (
          followup.answer || (
            <span className="text-muted-foreground italic">No answer.</span>
          )
        )}
      </div>
    </div>
  );
}
