import type { ChildProcess } from "child_process";
import { patchReviewSummary } from "./review-store";
import {
  readReviewLearnings,
  writeReviewLearnings,
} from "./review-learnings-store";
import {
  resolveReviewOpts,
  resolveReviewRunTimeoutMs,
  spawnRuntime,
} from "./review-runner";
import { readConfig } from "./store";
import type { ReviewSummary } from "./types";

export interface SpawnedRetro {
  pid: number;
  child: ChildProcess;
  done: Promise<void>;
}

export const DEFAULT_REVIEW_RETRO_PROMPT = `You maintain Cortex City's review learnings file for future inbound PR reviews.

Use the gh CLI to inspect the merged pull request and compare the prior agent review with the final outcome. Focus on transferable lessons that will improve future reviews.

Inspect:
- The final merged diff.
- The agent's own prior comments and whether they were addressed, dismissed, or resolved.
- Comments from other reviewers that the agent missed.
- What changed between the reviewed SHA and the merge.

Curation rules:
- Extract at most a couple of generalizable, actionable lessons, each tied to an observed hit or miss.
- Discard vague platitudes.
- Prefer generic lessons. Record a repo-specific lesson only when it genuinely cannot be generalized, and tag it with the repo slug.
- Integrate into the whole file: merge duplicates, drop weak or stale entries.
- Stay under a hard budget of roughly 30 to 40 lessons.
- Preserve human-edited content. Do not silently delete lessons that read as deliberate human guidance.
- Output the complete rewritten Markdown file only. The result text is the new file contents.`;

export function buildReviewRetroPrompt(
  review: ReviewSummary,
  learningsBefore: string
): string {
  const agentStatus = review.agent_review_status || "(not recorded)";
  const reviewedHeadSha = review.summary_head_sha || "(not recorded)";
  const currentHeadSha = review.head_sha || "(not recorded)";
  const summary = review.summary?.trim() || "(empty)";
  const currentLearnings = learningsBefore.trim() || "(empty)";

  return [
    DEFAULT_REVIEW_RETRO_PROMPT,
    "",
    "## Pull request outcome",
    `PR URL: ${review.pr_url}`,
    `Repository: ${review.repo_slug}`,
    `PR number: ${review.pr_number}`,
    `Title: ${review.title}`,
    `Author: ${review.author}`,
    `Reviewed head SHA: ${reviewedHeadSha}`,
    `Current recorded head SHA: ${currentHeadSha}`,
    "",
    "The PR has been merged. Use `gh` to inspect the final merged state before rewriting the learnings file.",
    "",
    "## What the review agent said",
    `Agent review status: ${agentStatus}`,
    "",
    "<agent_review_markdown>",
    summary,
    "</agent_review_markdown>",
    "",
    "## Current learnings file",
    "<review_learnings_markdown>",
    currentLearnings,
    "</review_learnings_markdown>",
    "",
    "Rewrite the complete learnings file now.",
  ].join("\n");
}

function retroErrorMessage(outputError?: string, resultText?: string): string {
  if (outputError?.trim()) return outputError.trim();
  if (!resultText?.trim()) return "Retro produced an empty learnings file.";
  return "Retro failed.";
}

export async function spawnReviewRetro(
  review: ReviewSummary,
  learningsBefore: string,
  onComplete?: () => Promise<void> | void
): Promise<SpawnedRetro> {
  const config = readConfig();
  const opts = resolveReviewOpts(config);
  const runTimeoutMs = resolveReviewRunTimeoutMs(config);
  const prompt = buildReviewRetroPrompt(review, learningsBefore);
  const { pid, child, done } = spawnRuntime(
    opts.runtime,
    prompt,
    opts,
    undefined,
    runTimeoutMs
  );

  await patchReviewSummary(review.pr_url, {
    retro_status: "pending",
    retro_run_pid: pid,
    retro_error: undefined,
  });

  const completion = done
    .then(async (output) => {
      const rewritten = output.result_text.trim();
      if (output.error || !rewritten) {
        await patchReviewSummary(review.pr_url, {
          retro_status: "error",
          retro_error: retroErrorMessage(output.error, output.result_text),
          retro_run_pid: undefined,
        });
        return;
      }

      if (readReviewLearnings() !== learningsBefore) {
        await patchReviewSummary(review.pr_url, {
          retro_status: "error",
          retro_error:
            "Review learnings changed during retro; leaving the current file untouched.",
          retro_run_pid: undefined,
        });
        return;
      }

      await writeReviewLearnings(`${rewritten}\n`);
      await patchReviewSummary(review.pr_url, {
        retro_status: "done",
        retro_done_at: new Date().toISOString(),
        retro_run_pid: undefined,
        retro_error: undefined,
      });
    })
    .catch(async (error) => {
      await patchReviewSummary(review.pr_url, {
        retro_status: "error",
        retro_error:
          error instanceof Error ? error.message : String(error || "Retro failed."),
        retro_run_pid: undefined,
      });
    })
    .finally(async () => {
      try {
        await onComplete?.();
      } catch {
        // Completion callbacks only release worker-local guards.
      }
    });

  return { pid, child, done: completion };
}
