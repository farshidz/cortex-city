import { exec as execCb } from "child_process";
import { createHash } from "crypto";

interface PRInfo {
  owner: string;
  repo: string;
  number: string;
}

interface ExecResult {
  ok: boolean;
  output: string;
  error: string;
}

interface StatusCheckRollupItem {
  name?: string;
  state?: string;
}

function parsePRUrl(url: string): PRInfo | null {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

function execResult(cmd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execCb(cmd, { encoding: "utf-8", timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "").trim();
        if (msg.includes("rate limit")) {
          console.error(`[github] Rate limited: ${cmd.slice(0, 80)}`);
        } else if (msg) {
          console.error(`[github] Command failed: ${cmd.slice(0, 80)} — ${msg.slice(0, 200)}`);
        }
        resolve({ ok: false, output: "", error: msg });
        return;
      }
      resolve({
        ok: true,
        output: (stdout || "").trim(),
        error: (stderr || "").trim(),
      });
    });
  });
}

async function exec(cmd: string): Promise<string> {
  const result = await execResult(cmd);
  return result.output;
}

async function execJson<T>(cmd: string): Promise<T | null> {
  const raw = await exec(cmd);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function execPaginatedArray<T>(endpoint: string): Promise<T[]> {
  const parsed = await execJson<unknown>(`gh api --paginate --slurp ${endpoint}`);
  if (!Array.isArray(parsed)) return [];
  const items: T[] = [];
  for (const page of parsed) {
    if (!Array.isArray(page)) continue;
    items.push(...(page as T[]));
  }
  return items;
}

async function execJsonStrict<T>(cmd: string): Promise<T | null> {
  const result = await execResult(cmd);
  if (!result.ok || !result.output) return null;
  try {
    return JSON.parse(result.output) as T;
  } catch {
    return null;
  }
}

async function execPaginatedArrayStrict<T>(endpoint: string): Promise<T[] | null> {
  const parsed = await execJsonStrict<unknown>(`gh api --paginate --slurp ${endpoint}`);
  if (!Array.isArray(parsed)) return null;
  const items: T[] = [];
  for (const page of parsed) {
    if (!Array.isArray(page)) return null;
    items.push(...(page as T[]));
  }
  return items;
}

function serializeCheckStates(checks: StatusCheckRollupItem[]): string {
  return checks
    .filter((check) => typeof check.name === "string" && typeof check.state === "string")
    .map((check) => `${check.name}=${check.state}`)
    .sort()
    .join(",");
}

function isNoChecksError(message: string): boolean {
  return /no checks reported/i.test(message);
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

  const [reviews, comments, checks] = await Promise.all([
    execPaginatedArray<{ state?: string }>(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
    ),
    execPaginatedArray<unknown>(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`
    ),
    exec(`gh pr checks ${prUrl} 2>&1`),
  ]);

  if (reviews.some((review) => review.state === "CHANGES_REQUESTED")) return true;
  if (comments.length > 0) return true;
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

  const [reviews, comments, issueComments] = await Promise.all([
    execPaginatedArray<{ id: number; state?: string }>(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
    ),
    execPaginatedArray<{ id: number; pull_request_review_id: number | null }>(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`
    ),
    execPaginatedArray<{ id: number }>(
      `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`
    ),
  ]);

  const submittedIds = reviews
    .filter((review) => review.state !== "PENDING")
    .map((review) => review.id);

  // Inline review comments from submitted reviews + PR-level conversation comments
  const reviewCommentIds = comments
    .filter((comment) =>
      comment.pull_request_review_id === null ||
      submittedIds.includes(comment.pull_request_review_id)
    )
    .map((comment) => comment.id);

  return [...reviewCommentIds, ...issueComments.map((comment) => comment.id)].sort();
}

export async function getPRStateHash(prUrl: string): Promise<string> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return "";

  const [prData, reviews, comments, issueComments, checksResult] = await Promise.all([
    execJsonStrict<{
      headRefOid?: string;
      statusCheckRollup?: StatusCheckRollupItem[];
    }>(
      `gh pr view ${prUrl} --json headRefOid,statusCheckRollup`
    ),
    execPaginatedArrayStrict<{ id: number; state?: string }>(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
    ),
    execPaginatedArrayStrict<{ id: number; pull_request_review_id: number | null }>(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`
    ),
    execPaginatedArrayStrict<{ id: number }>(
      `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`
    ),
    execResult(
      `gh pr checks ${prUrl} --json name,state --jq '[.[] | .name + "=" + .state] | sort | join(",")'`
    ),
  ]);
  if (
    !prData ||
    typeof prData.headRefOid !== "string" ||
    !reviews ||
    !comments ||
    !issueComments
  ) {
    return "";
  }

  const headSha = prData.headRefOid.trim();
  if (!headSha) return "";

  let ciStatus = checksResult.output;
  if (!checksResult.ok) {
    if (isNoChecksError(checksResult.error)) {
      const checks = Array.isArray(prData.statusCheckRollup)
        ? prData.statusCheckRollup
        : [];
      ciStatus = serializeCheckStates(checks);
    } else {
      return "";
    }
  }

  const submittedIds = reviews
    .filter((review) => review.state !== "PENDING")
    .map((review) => review.id);
  const filteredCommentIds = JSON.stringify(
    comments
      .filter((comment) =>
        comment.pull_request_review_id === null ||
        submittedIds.includes(comment.pull_request_review_id)
      )
      .map((comment) => comment.id)
      .sort()
  );
  const issueCommentIds = JSON.stringify(
    issueComments.map((comment) => comment.id).sort()
  );
  const reviewIds = JSON.stringify(
    reviews
      .filter((review) => review.state !== "PENDING")
      .map((review) => ({ id: review.id, state: review.state ?? "" }))
      .sort((a, b) => a.id - b.id)
  );
  const combined = `${headSha}|${filteredCommentIds}|${issueCommentIds}|${reviewIds}|${ciStatus}`;
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}
