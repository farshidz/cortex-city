import { exec as execCb } from "child_process";
import { createHash } from "crypto";

interface PRInfo {
  owner: string;
  repo: string;
  number: string;
}

function parsePRUrl(url: string): PRInfo | null {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

function exec(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    execCb(cmd, { encoding: "utf-8", timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "").trim();
        if (msg.includes("rate limit")) {
          console.error(`[github] Rate limited: ${cmd.slice(0, 80)}`);
        } else if (msg) {
          console.error(`[github] Command failed: ${cmd.slice(0, 80)} — ${msg.slice(0, 200)}`);
        }
        resolve("");
        return;
      }
      resolve((stdout || "").trim());
    });
  });
}

export async function getCIStatus(prUrl: string): Promise<string> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return "Could not parse PR URL.";

  const checks = await exec(`gh pr checks ${prUrl} 2>&1`);
  return checks || "No CI checks found.";
}

export async function prNeedsAttention(prUrl: string): Promise<boolean> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return false;

  const [pendingReviews, commentCount, checks] = await Promise.all([
    exec(
      `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews --jq '[.[] | select(.state == "CHANGES_REQUESTED")] | length'`
    ),
    exec(
      `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments --jq 'length'`
    ),
    exec(`gh pr checks ${prUrl} 2>&1`),
  ]);

  if (pendingReviews && parseInt(pendingReviews) > 0) return true;
  if (commentCount && parseInt(commentCount) > 0) return true;
  if (checks.includes("fail") || checks.includes("X ")) return true;

  return false;
}

export async function isPRBehindBase(prUrl: string): Promise<boolean> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return false;

  // Get head and base refs
  const refs = await exec(
    `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number} --jq '.head.ref + "..." + .base.ref'`
  );
  if (!refs.includes("...")) return false;

  // Use compare endpoint — pulls endpoint doesn't reliably return behind_by
  const behindBy = await exec(
    `gh api repos/${pr.owner}/${pr.repo}/compare/${refs} --jq '.behind_by'`
  );
  return parseInt(behindBy) > 0;
}

export async function updatePRBranch(prUrl: string): Promise<void> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return;

  exec(
    `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/update-branch -X PUT 2>&1`
  );
}

export async function getPRStatus(
  prUrl: string
): Promise<"clean" | "checks_failing" | "checks_pending" | "needs_approval" | "conflicts" | "unstable" | "unknown"> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return "unknown";

  const [pendingCount, prData] = await Promise.all([
    exec(
      `gh pr checks ${prUrl} --json state --jq '[.[] | select(.state != "SUCCESS" and .state != "FAILURE" and .state != "CANCELLED" and .state != "SKIPPED" and .state != "STALE" and .state != "ERROR" and .state != "NEUTRAL" and .state != "STARTUP_FAILURE")] | length'`
    ),
    exec(
      `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number} --jq '{mergeable_state, mergeable}'`
    ),
  ]);

  if (parseInt(pendingCount) > 0) return "checks_pending";

  let mergeableState = "";
  let mergeable = "";
  try {
    const parsed = JSON.parse(prData);
    mergeableState = parsed.mergeable_state || "";
    mergeable = String(parsed.mergeable);
  } catch {
    return "unknown";
  }

  if (mergeableState === "clean") return "clean";
  if (mergeableState === "dirty") return "conflicts";
  if (mergeableState === "unstable") return "unstable";

  if (mergeableState === "blocked") {
    if (mergeable === "true") return "needs_approval";
    return "checks_failing";
  }

  return "unknown";
}

export async function isPRMergedOrClosed(prUrl: string): Promise<"merged" | "closed" | null> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return null;

  const state = await exec(
    `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number} --jq '.state + "|" + (.merged | tostring)'`
  );
  if (state.includes("|true")) return "merged";
  if (state.startsWith("closed")) return "closed";
  return null;
}

export async function hasPendingChecks(prUrl: string): Promise<boolean> {
  const result = await exec(
    `gh pr checks ${prUrl} --json state --jq '[.[] | select(.state != "SUCCESS" and .state != "FAILURE" and .state != "CANCELLED" and .state != "SKIPPED" and .state != "STALE" and .state != "ERROR" and .state != "NEUTRAL" and .state != "STARTUP_FAILURE")] | length'`
  );
  return parseInt(result) > 0;
}

export async function getSubmittedCommentIds(prUrl: string): Promise<number[]> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return [];

  const [submittedReviewsRaw, commentsRaw, issueCommentsRaw] = await Promise.all([
    exec(`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews --jq '[.[] | select(.state != "PENDING") | .id]'`),
    exec(`gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments --jq '[.[] | {id, review_id: .pull_request_review_id}]'`),
    exec(`gh api repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments --jq '[.[].id]'`),
  ]);

  const submittedIds: number[] = (() => { try { return JSON.parse(submittedReviewsRaw || "[]"); } catch { return []; } })();
  const comments: { id: number; review_id: number | null }[] = (() => { try { return JSON.parse(commentsRaw || "[]"); } catch { return []; } })();
  const issueCommentIds: number[] = (() => { try { return JSON.parse(issueCommentsRaw || "[]"); } catch { return []; } })();

  // Inline review comments from submitted reviews + PR-level conversation comments
  const reviewCommentIds = comments
    .filter((c) => c.review_id === null || submittedIds.includes(c.review_id))
    .map((c) => c.id);

  return [...reviewCommentIds, ...issueCommentIds].sort();
}

export async function getPRStateHash(prUrl: string): Promise<string> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return "";

  // Get submitted review IDs to whitelist their comments in the hash
  const submittedReviewIdsRaw = await exec(
    `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews --jq '[.[] | select(.state != "PENDING") | .id]'`
  );
  const submittedIds: number[] = (() => {
    try { return JSON.parse(submittedReviewIdsRaw || "[]"); } catch { return []; }
  })();

  const [headSha, allComments, issueCommentIds, reviewIds, ciStatus] = await Promise.all([
    exec(
      `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number} --jq '.head.sha'`
    ),
    // Inline review comments
    exec(
      `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments --jq '[.[] | {id, review_id: .pull_request_review_id}]'`
    ),
    // PR-level conversation comments
    exec(
      `gh api repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments --jq '[.[].id] | sort'`
    ),
    // Only submitted reviews
    exec(
      `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews --jq '[.[] | select(.state != "PENDING") | {id, state}] | sort_by(.id)'`
    ),
    exec(
      `gh pr checks ${prUrl} --json name,state --jq '[.[] | .name + "=" + .state] | sort | join(",")'`
    ),
  ]);

  // Only include comments from submitted reviews (whitelist approach)
  let filteredCommentIds = "[]";
  try {
    const comments: { id: number; review_id: number | null }[] = JSON.parse(allComments || "[]");
    const submitted = comments.filter(
      (c) => c.review_id === null || submittedIds.includes(c.review_id)
    );
    filteredCommentIds = JSON.stringify(submitted.map((c) => c.id).sort());
  } catch {}

  const combined = `${headSha}|${filteredCommentIds}|${issueCommentIds}|${reviewIds}|${ciStatus}`;
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}
