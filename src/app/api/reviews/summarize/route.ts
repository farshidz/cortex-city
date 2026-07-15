import { NextRequest, NextResponse } from "next/server";
import { getReviewSummary } from "@/lib/review-store";
import {
  ReviewRunInFlightError,
  summarizePR,
} from "@/lib/review-runner";
import type { AgentRuntime, TaskEffort } from "@/lib/types";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const prUrl = typeof body?.pr_url === "string" ? body.pr_url.trim() : "";
  if (!prUrl) {
    return NextResponse.json({ error: "pr_url is required" }, { status: 400 });
  }

  const cached = getReviewSummary(prUrl);
  if (!cached) {
    return NextResponse.json(
      { error: "PR is not cached for review yet" },
      { status: 404 }
    );
  }

  if (cached.current_run_pid) {
    return NextResponse.json(
      { error: "A summary run is already in flight for this PR" },
      { status: 409 }
    );
  }

  const overrides: { runtime?: AgentRuntime; effort?: TaskEffort; model?: string } = {};
  if (body.runtime === "claude" || body.runtime === "codex") {
    overrides.runtime = body.runtime;
  }
  if (typeof body.effort === "string" && body.effort.trim()) {
    overrides.effort = body.effort as TaskEffort;
  }
  if (typeof body.model === "string" && body.model.trim()) {
    overrides.model = body.model.trim();
  }

  let result: Awaited<ReturnType<typeof summarizePR>>;
  try {
    result = await summarizePR(
      {
        pr_url: cached.pr_url,
        pr_number: cached.pr_number,
        repo_slug: cached.repo_slug,
        title: cached.title,
        author: cached.author,
        head_sha: cached.head_sha,
        created_at: cached.created_at,
        updated_at: cached.updated_at,
        my_last_review_sha: cached.my_last_review_sha,
        my_approval_sha: cached.my_approval_sha,
        my_changes_requested_sha: cached.my_changes_requested_sha,
      },
      overrides
    );
  } catch (error) {
    if (error instanceof ReviewRunInFlightError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json(result);
}
