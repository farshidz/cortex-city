"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, ExternalLink, RefreshCcw } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { decodeReviewId } from "@/lib/review-id";
import { getEffortOptions } from "@/lib/runtime-config";
import type {
  AgentRuntime,
  OrchestratorConfig,
  ReviewFollowup,
  ReviewState,
  ReviewSummary,
  TaskEffort,
} from "@/lib/types";

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

interface SubmitState {
  decision: "approve" | "request-changes" | "comment";
  body: string;
  submitting: boolean;
  error?: string;
}

export default function ReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const prUrl = useMemo(() => {
    try {
      return decodeReviewId(id);
    } catch {
      return "";
    }
  }, [id]);

  const { data: reviews, mutate } = useSWR<ReviewSummary[]>(
    "/api/reviews",
    fetcher,
    { refreshInterval: 5000 }
  );
  const { data: config } = useSWR<OrchestratorConfig>("/api/config", fetcher);

  const review = reviews?.find((r) => r.pr_url === prUrl);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [runtimeOverride, setRuntimeOverride] = useState<AgentRuntime | "">("");
  const [effortOverride, setEffortOverride] = useState<TaskEffort | "">("");
  const [submitState, setSubmitState] = useState<SubmitState | null>(null);

  const defaultRuntime: AgentRuntime =
    config?.review_runtime || config?.default_agent_runner || "claude";
  const activeRuntime: AgentRuntime = runtimeOverride || defaultRuntime;

  async function regenerate() {
    if (!review) return;
    setRegenerating(true);
    try {
      await fetch("/api/reviews/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pr_url: review.pr_url,
          runtime: runtimeOverride || undefined,
          effort: effortOverride || undefined,
        }),
      });
      mutate();
    } finally {
      setRegenerating(false);
    }
  }

  async function askFollowup() {
    if (!review) return;
    const trimmed = question.trim();
    if (!trimmed) return;
    setAsking(true);
    try {
      await fetch("/api/reviews/followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pr_url: review.pr_url, question: trimmed }),
      });
      setQuestion("");
      mutate();
    } finally {
      setAsking(false);
    }
  }

  async function submitReview() {
    if (!review || !submitState) return;
    setSubmitState({ ...submitState, submitting: true, error: undefined });
    const res = await fetch("/api/reviews/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pr_url: review.pr_url,
        decision: submitState.decision,
        body: submitState.body,
      }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      setSubmitState({
        ...submitState,
        submitting: false,
        error: payload?.error || "Failed to submit review",
      });
      return;
    }
    setSubmitState(null);
    mutate();
  }

  if (!prUrl) {
    return (
      <div className="space-y-4">
        <Link href="/reviews" className="text-sm hover:underline">
          ← Back to Reviews
        </Link>
        <div className="text-destructive">Invalid review URL.</div>
      </div>
    );
  }

  if (reviews && !review) {
    return (
      <div className="space-y-4">
        <Link href="/reviews" className="text-sm hover:underline">
          ← Back to Reviews
        </Link>
        <div className="text-muted-foreground">
          Review not found. It may have been pruned.
        </div>
        <div className="text-xs text-muted-foreground font-mono break-all">
          {prUrl}
        </div>
      </div>
    );
  }

  if (!review) {
    return <div className="text-muted-foreground">Loading…</div>;
  }

  const isSummarizing =
    review.review_state === "needs_approval" &&
    Boolean(review.current_run_pid) &&
    !review.summary;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <Link
          href="/reviews"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to Reviews
        </Link>
        <a href={review.pr_url} target="_blank" rel="noopener noreferrer">
          <Button size="sm" variant="outline" className="gap-1">
            <ExternalLink className="size-3.5" />
            Open PR
          </Button>
        </a>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-muted-foreground">
            {review.repo_slug} #{review.pr_number}
          </span>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(
              review.review_state
            )}`}
          >
            {STATUS_LABEL[review.review_state ?? "needs_approval"]}
          </span>
          <Badge variant="outline">{review.author || "—"}</Badge>
        </div>
        <h1 className="text-2xl font-bold leading-tight">{review.title}</h1>
      </div>

      <div className="rounded border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="text-sm font-medium">Summary</div>
          <div className="flex items-center gap-2">
            <Select
              value={runtimeOverride || defaultRuntime}
              onValueChange={(v) => {
                setRuntimeOverride(v as AgentRuntime);
                setEffortOverride("");
              }}
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
              value={effortOverride || "__default__"}
              onValueChange={(v) =>
                setEffortOverride(v === "__default__" ? "" : (v as TaskEffort))
              }
            >
              <SelectTrigger className="h-7 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">Effort: default</SelectItem>
                {getEffortOptions(activeRuntime).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              onClick={regenerate}
              disabled={Boolean(review.current_run_pid) || regenerating}
            >
              <RefreshCcw className="size-3.5" />
              {regenerating || review.current_run_pid
                ? "Regenerating…"
                : "Regenerate"}
            </Button>
          </div>
        </div>
        <div className="px-4 py-4 text-sm min-h-[6rem]">
          {isSummarizing ? (
            <span className="text-muted-foreground italic">Summarizing…</span>
          ) : review.error ? (
            <span className="text-destructive">{review.error}</span>
          ) : review.summary ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown>{review.summary}</ReactMarkdown>
            </div>
          ) : (
            <span className="text-muted-foreground italic">
              No summary yet.
            </span>
          )}
        </div>
        {review.generated_at && (
          <div className="border-t px-4 py-2 text-xs text-muted-foreground">
            Generated {new Date(review.generated_at).toLocaleString()}
            {review.runtime ? ` · ${review.runtime}` : ""}
            {review.effort ? ` · ${review.effort}` : ""}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="text-sm font-medium">Follow-up</div>
        {(review.followups || []).map((f, idx) => (
          <FollowupBlock key={idx} followup={f} />
        ))}
        <div className="flex flex-col gap-2 rounded border bg-card p-3">
          <Textarea
            placeholder="Ask a follow-up question about this summary…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={askFollowup}
              disabled={asking || !question.trim() || !review.summary}
            >
              {asking ? "Asking…" : "Send"}
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">Submit a review</div>
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setSubmitState({
                decision: "approve",
                body: "",
                submitting: false,
              })
            }
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setSubmitState({
                decision: "request-changes",
                body: "",
                submitting: false,
              })
            }
          >
            Request changes
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setSubmitState({
                decision: "comment",
                body: "",
                submitting: false,
              })
            }
          >
            Comment
          </Button>
        </div>
      </div>

      {submitState && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSubmitState(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {submitState.decision === "approve"
                  ? "Approve PR"
                  : submitState.decision === "request-changes"
                    ? "Request changes"
                    : "Comment on PR"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Textarea
                placeholder={
                  submitState.decision === "approve"
                    ? "Optional approval note"
                    : "Review body (required)"
                }
                value={submitState.body}
                onChange={(e) =>
                  setSubmitState({ ...submitState, body: e.target.value })
                }
                rows={6}
              />
              {submitState.error && (
                <div className="text-sm text-destructive">
                  {submitState.error}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSubmitState(null)}>
                Cancel
              </Button>
              <Button onClick={submitReview} disabled={submitState.submitting}>
                {submitState.submitting ? "Submitting…" : "Submit"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function FollowupBlock({ followup }: { followup: ReviewFollowup }) {
  return (
    <div className="rounded border bg-card p-3 text-sm space-y-2">
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
      {followup.error ? (
        <div className="text-destructive">{followup.error}</div>
      ) : followup.answer ? (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown>{followup.answer}</ReactMarkdown>
        </div>
      ) : (
        <div className="text-muted-foreground italic">No answer.</div>
      )}
    </div>
  );
}
