import { exec as execCb, execFile as execFileCb } from "child_process";
import { createHash } from "crypto";
import {
  REVIEWER_HUMAN_DECISION_COMMENT_PREFIX,
  REVIEWER_SELF_APPROVAL_COMMENT_PREFIX,
  reviewerCommentBodySha256,
  reviewerHumanDecisionCommentMarker,
} from "./review-comments";
import { getReviewSummary } from "./review-store";
import type {
  PRStatus,
  ReviewerCommentDelivery,
  ReviewerCommentReceipt,
  ReviewRequest,
} from "./types";

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

interface ReviewCommentItem {
  id: number;
  pull_request_review_id: number | null;
}

interface ReviewItem {
  id: number;
  state?: string;
  body?: string | null;
}

interface IssueCommentItem {
  id: number;
  body?: string | null;
  user?: { login?: string };
}

function verifiedReviewerCommentIds(prUrl: string): Set<number> {
  const review = getReviewSummary(prUrl);
  return new Set(
    (review?.reviewer_comment_receipts || []).map(
      (receipt) => receipt.comment_id
    )
  );
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

function isCommentFromSubmittedReview(
  comment: ReviewCommentItem,
  submittedReviewIds: Set<number>
): boolean {
  return (
    typeof comment.pull_request_review_id === "number" &&
    submittedReviewIds.has(comment.pull_request_review_id)
  );
}

function isHashSignificantReview(review: Pick<ReviewItem, "state" | "body">): boolean {
  const state = (review.state || "").toUpperCase();
  if (state === "PENDING") return false;
  return state !== "APPROVED" || Boolean((review.body || "").trim());
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

export async function getPRStatus(prUrl: string): Promise<PRStatus> {
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

  const result = await execResult(
    `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number} --jq '.state + "|" + (.merged | tostring)'`
  );
  if (!result.ok) {
    throw new Error(result.error || "Failed to inspect pull request state.");
  }
  const state = result.output;
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

export async function getPRHeadSha(prUrl: string): Promise<string> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return "";

  const data = await execJson<{ headRefOid?: string }>(
    `gh pr view ${prUrl} --json headRefOid`
  );
  return data?.headRefOid?.trim() || "";
}

export async function getSubmittedCommentIds(prUrl: string): Promise<number[]> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return [];

  const [reviews, comments, issueComments] = await Promise.all([
    execPaginatedArray<{ id: number; state?: string }>(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
    ),
    execPaginatedArray<ReviewCommentItem>(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`
    ),
    execPaginatedArray<IssueCommentItem>(
      `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`
    ),
  ]);

  const submittedIds = new Set(
    reviews
      .filter((review) => review.state !== "PENDING")
      .map((review) => review.id)
  );

  // `/pulls/{n}/comments` is the inline-review surface. PR conversation
  // comments come from `/issues/{n}/comments`; review-id-null inline comments
  // can be draft review artifacts and must not trigger review runs.
  const reviewCommentIds = comments
    .filter((comment) => isCommentFromSubmittedReview(comment, submittedIds))
    .map((comment) => comment.id);

  const ignoredIssueCommentIds = verifiedReviewerCommentIds(prUrl);
  const issueCommentIds = issueComments
    .filter((comment) => !ignoredIssueCommentIds.has(comment.id))
    .map((comment) => comment.id);

  return [...reviewCommentIds, ...issueCommentIds].sort();
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
    execPaginatedArrayStrict<ReviewItem>(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
    ),
    execPaginatedArrayStrict<ReviewCommentItem>(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`
    ),
    execPaginatedArrayStrict<IssueCommentItem>(
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

  const submittedIds = new Set(
    reviews
      .filter((review) => review.state !== "PENDING")
      .map((review) => review.id)
  );
  const filteredCommentIds = JSON.stringify(
    comments
      .filter((comment) => isCommentFromSubmittedReview(comment, submittedIds))
      .map((comment) => comment.id)
      .sort()
  );
  const ignoredIssueCommentIds = verifiedReviewerCommentIds(prUrl);
  const issueCommentIds = JSON.stringify(
    issueComments
      .filter((comment) => !ignoredIssueCommentIds.has(comment.id))
      .map((comment) => comment.id)
      .sort()
  );
  const reviewIds = JSON.stringify(
    reviews
      .filter(isHashSignificantReview)
      .map((review) => ({ id: review.id, state: review.state ?? "" }))
      .sort((a, b) => a.id - b.id)
  );
  const combined = `${headSha}|${filteredCommentIds}|${issueCommentIds}|${reviewIds}|${ciStatus}`;
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

interface SearchResultPR {
  url?: string;
  number?: number;
  title?: string;
  repository?: { nameWithOwner?: string };
  author?: { login?: string };
  createdAt?: string;
  updatedAt?: string;
}

interface PRViewResult {
  headRefOid?: string;
}

interface PRReviewItem {
  id?: number;
  user?: { login?: string };
  commit_id?: string;
  state?: string;
  submitted_at?: string;
}

function compareReviewsNewest(a: PRReviewItem, b: PRReviewItem): number {
  const submittedAtOrder = (b.submitted_at || "").localeCompare(
    a.submitted_at || ""
  );
  if (submittedAtOrder !== 0) return submittedAtOrder;

  // GitHub review timestamps are second-granular. Numeric review IDs preserve
  // creation order when two decisive reviews are submitted in the same second.
  const aId =
    typeof a.id === "number" && Number.isSafeInteger(a.id) ? a.id : 0;
  const bId =
    typeof b.id === "number" && Number.isSafeInteger(b.id) ? b.id : 0;
  if (aId === bId) return 0;
  return bId > aId ? 1 : -1;
}

const CORTEX_CITY_REVIEW_LABEL = "cortex-city-review";

async function searchOpenReviewPRs(query: string): Promise<SearchResultPR[]> {
  const command =
    `gh search prs ${query} draft:false --archived=false --state=open --json url,number,title,repository,author,createdAt,updatedAt --limit 200`;
  const result = await execResult(command);
  if (!result.ok) {
    throw new Error(result.error || `Failed to search open PRs for ${query}`);
  }
  if (!result.output) return [];
  try {
    const parsed = JSON.parse(result.output) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("GitHub PR search returned a non-array response");
    }
    return parsed as SearchResultPR[];
  } catch (error) {
    throw new Error(
      `Failed to parse GitHub PR search for ${query}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function getMyLastReviewSha(
  prUrl: string,
  login: string
): Promise<string | undefined> {
  const pr = parsePRUrl(prUrl);
  if (!pr || !login) return undefined;
  const reviews = await execPaginatedArrayStrict<PRReviewItem>(
    `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
  );
  if (!reviews) return undefined;
  const mine = reviews.filter(
    (r) => r.user?.login === login && r.state !== "PENDING" && r.commit_id
  );
  if (mine.length === 0) return undefined;
  mine.sort(compareReviewsNewest);
  return mine[0].commit_id || undefined;
}

// Fetch the signed-in user's review signals for a PR in a single reviews call:
// - last_review_sha: most recent non-PENDING review's commit (matches
//   getMyLastReviewSha; signature-blind, includes the agent's COMMENTED reviews).
// - approval_sha: the commit of the user's current decision review, but only when
//   that latest decision is an APPROVAL. Comment-only reviews are ignored so the
//   agent's own COMMENTED reviews can't mask a real approval; a later
//   CHANGES_REQUESTED supersedes an earlier approval; and a later DISMISSED
//   (e.g. an approval that GitHub dismissed) means there is no active approval.
// - changes_requested_sha: the symmetric signal — set only when the user's latest
//   decision is CHANGES_REQUESTED. Lets a human change request supersede a stale
//   agent verdict the same way an approval does.
export interface MyReviewSignals {
  last_review_sha?: string;
  approval_sha?: string;
  changes_requested_sha?: string;
}

export async function getMyReviewSignals(
  prUrl: string,
  login: string
): Promise<MyReviewSignals> {
  const pr = parsePRUrl(prUrl);
  if (!pr || !login) return {};
  const reviews = await execPaginatedArrayStrict<PRReviewItem>(
    `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
  );
  if (!reviews) return {};
  const mine = reviews.filter((r) => r.user?.login === login && r.commit_id);
  if (mine.length === 0) return {};

  const lastReview = [...mine]
    .filter((r) => r.state !== "PENDING")
    .sort(compareReviewsNewest)[0];

  // DISMISSED is included so that a dismissed review (GitHub's signal that a
  // prior approval no longer counts) supersedes an older APPROVED instead of
  // letting it fall through and be reported as an active approval.
  const latestDecision = [...mine]
    .filter(
      (r) =>
        r.state === "APPROVED" ||
        r.state === "CHANGES_REQUESTED" ||
        r.state === "DISMISSED"
    )
    .sort(compareReviewsNewest)[0];

  return {
    last_review_sha: lastReview?.commit_id || undefined,
    approval_sha:
      latestDecision?.state === "APPROVED"
        ? latestDecision.commit_id || undefined
        : undefined,
    changes_requested_sha:
      latestDecision?.state === "CHANGES_REQUESTED"
        ? latestDecision.commit_id || undefined
        : undefined,
  };
}

export async function getReviewRequestedPRs(): Promise<ReviewRequest[]> {
  let myLogin = "";
  try {
    myLogin = await getAuthenticatedUserLogin();
  } catch {
    myLogin = "";
  }
  const requestedSearch = searchOpenReviewPRs("user-review-requested:@me");
  const reviewedSearch = myLogin
    ? searchOpenReviewPRs(`reviewed-by:${myLogin}`)
    : Promise.resolve([]);
  const labeledSearch = searchOpenReviewPRs(
    `label:${CORTEX_CITY_REVIEW_LABEL}`
  );

  // GitHub clears a direct review request once the user submits a review.
  // Keep those open PRs live by also including PRs the user has reviewed.
  const [requested, reviewed, labeled] = await Promise.all([
    requestedSearch,
    reviewedSearch,
    labeledSearch,
  ]);
  const labeledUrls = new Set(
    labeled.map((pr) => (pr.url || "").trim()).filter(Boolean)
  );
  const standardUrls = new Set(
    [...requested, ...reviewed]
      .filter((pr) => !myLogin || pr.author?.login?.trim() !== myLogin)
      .map((pr) => (pr.url || "").trim())
      .filter(Boolean)
  );
  const resultsByUrl = new Map<string, SearchResultPR>();
  for (const pr of [...requested, ...reviewed, ...labeled]) {
    const url = (pr.url || "").trim();
    const author = pr.author?.login?.trim();
    // The label is an explicit opt-in, including for the signed-in user's PRs.
    if (myLogin && author === myLogin && !labeledUrls.has(url)) continue;
    if (url && !resultsByUrl.has(url)) {
      resultsByUrl.set(url, pr);
    }
  }
  const results = [...resultsByUrl.values()];
  if (results.length === 0) return [];

  const enriched = await Promise.all(
    results.map(async (pr): Promise<ReviewRequest | null> => {
      const url = (pr.url || "").trim();
      const repoSlug = pr.repository?.nameWithOwner?.trim() || "";
      const parsed = parsePRUrl(url);
      if (!url || !parsed || typeof pr.number !== "number" || !repoSlug) {
        return null;
      }

      const [headData, signals] = await Promise.all([
        execJsonStrict<PRViewResult>(`gh pr view ${url} --json headRefOid`),
        myLogin
          ? getMyReviewSignals(url, myLogin).catch(
              (): MyReviewSignals => ({})
            )
          : Promise.resolve<MyReviewSignals>({}),
      ]);

      const headSha = headData?.headRefOid?.trim() || "";
      if (!headSha) return null;

      return {
        label_only:
          labeledUrls.has(url) && !standardUrls.has(url) ? true : undefined,
        self_authored:
          myLogin && pr.author?.login?.trim() === myLogin ? true : undefined,
        pr_url: url,
        pr_number: pr.number,
        repo_slug: repoSlug,
        title: (pr.title || "").trim(),
        author: pr.author?.login?.trim() || "",
        head_sha: headSha,
        created_at: pr.createdAt || "",
        updated_at: pr.updatedAt || "",
        my_last_review_sha: signals.last_review_sha,
        my_approval_sha: signals.approval_sha,
        my_changes_requested_sha: signals.changes_requested_sha,
      };
    })
  );

  return enriched.filter((entry): entry is ReviewRequest => entry !== null);
}

let cachedViewerLogin: string | null = null;

export async function getAuthenticatedUserLogin(): Promise<string> {
  if (cachedViewerLogin) return cachedViewerLogin;
  const login = await exec(`gh api user --jq .login`);
  cachedViewerLogin = login.trim();
  return cachedViewerLogin;
}

interface PRStateView {
  state?: string;
  merged?: boolean;
  latestReviews?: Array<{
    state?: string;
    author?: { login?: string };
  }>;
}

export async function getReviewLifecycleState(
  prUrl: string
): Promise<"approved" | "merged_closed" | "needs_approval"> {
  const data = await execJsonStrict<PRStateView>(
    `gh pr view ${prUrl} --json state,merged,latestReviews`
  );
  if (!data) return "needs_approval";

  if (data.merged === true) return "merged_closed";
  const state = (data.state || "").toUpperCase();
  if (state === "MERGED") return "merged_closed";
  if (state === "CLOSED") return "merged_closed";

  let myLogin = "";
  try {
    myLogin = await getAuthenticatedUserLogin();
  } catch {
    myLogin = "";
  }
  if (myLogin && Array.isArray(data.latestReviews)) {
    const approved = data.latestReviews.some(
      (review) =>
        review.author?.login === myLogin &&
        (review.state || "").toUpperCase() === "APPROVED"
    );
    if (approved) return "approved";
  }

  return "needs_approval";
}

function execFileResult(
  command: string,
  args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFileCb(
      command,
      args,
      { encoding: "utf-8", timeout: 30000 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: (stdout || "").toString(),
          stderr: (stderr || (err?.message ?? "")).toString(),
        });
      }
    );
  });
}

function assertReviewerCommentDelivery(
  delivery: ReviewerCommentDelivery
): void {
  const tokenIsValid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      delivery.action_token
    );
  const expectedPrefix =
    delivery.kind === "human_decision"
      ? REVIEWER_HUMAN_DECISION_COMMENT_PREFIX
      : delivery.kind === "manual_approval"
        ? REVIEWER_SELF_APPROVAL_COMMENT_PREFIX
        : undefined;
  if (
    !tokenIsValid ||
    !delivery.head_sha.trim() ||
    !expectedPrefix ||
    !delivery.body.startsWith(`${expectedPrefix} `) ||
    !delivery.body.endsWith(
      `\n\n${reviewerHumanDecisionCommentMarker(delivery.action_token)}`
    )
  ) {
    throw new Error("Invalid reviewer comment delivery action.");
  }
}

function verifiedReviewerCommentReceipt(
  delivery: ReviewerCommentDelivery,
  comment: IssueCommentItem,
  authorLogin: string
): ReviewerCommentReceipt {
  if (
    !Number.isSafeInteger(comment.id) ||
    comment.id <= 0 ||
    comment.user?.login !== authorLogin ||
    comment.body !== delivery.body
  ) {
    throw new Error(
      "GitHub did not return a verifiable reviewer comment receipt."
    );
  }
  return {
    action_token: delivery.action_token,
    comment_id: comment.id,
    author_login: authorLogin,
    body_sha256: reviewerCommentBodySha256(delivery.body),
  };
}

async function getIssueComment(
  endpoint: string
): Promise<IssueCommentItem | null> {
  const result = await execFileResult("gh", ["api", endpoint]);
  if (!result.ok || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout) as IssueCommentItem;
  } catch {
    return null;
  }
}

export async function deliverReviewerComment(
  prUrl: string,
  delivery: ReviewerCommentDelivery
): Promise<ReviewerCommentReceipt> {
  const pr = parsePRUrl(prUrl);
  if (!pr) throw new Error("Invalid reviewer comment target.");
  assertReviewerCommentDelivery(delivery);

  const authorLogin = await getAuthenticatedUserLogin();
  if (!authorLogin) {
    throw new Error("GitHub did not return the reviewer comment author.");
  }

  const endpoint =
    `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`;
  const existing = await execPaginatedArrayStrict<IssueCommentItem>(endpoint);
  if (!existing) {
    throw new Error("Failed to inspect existing PR conversation comments.");
  }
  const recovered = existing
    .filter(
      (comment) =>
        comment.user?.login === authorLogin && comment.body === delivery.body
    )
    .sort((a, b) => a.id - b.id)[0];
  if (recovered) {
    return verifiedReviewerCommentReceipt(
      delivery,
      recovered,
      authorLogin
    );
  }

  const result = await execFileResult("gh", [
    "api",
    "--method",
    "POST",
    endpoint,
    "--raw-field",
    `body=${delivery.body}`,
    "--jq",
    ".id",
  ]);
  const id = Number(result.stdout.trim());
  if (!result.ok || !Number.isSafeInteger(id) || id <= 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `Failed to post the reviewer comment${detail ? `: ${detail}` : "."}`
    );
  }
  const posted = await getIssueComment(
    `repos/${pr.owner}/${pr.repo}/issues/comments/${id}`
  );
  if (!posted) {
    throw new Error("Failed to verify the posted reviewer comment receipt.");
  }
  return verifiedReviewerCommentReceipt(delivery, posted, authorLogin);
}

export const __testUtils = {
  parsePRUrl,
  isNoChecksError,
  serializeCheckStates,
  isCommentFromSubmittedReview,
  isHashSignificantReview,
};

export async function submitPRReview(
  prUrl: string,
  decision: "approve" | "request-changes" | "comment",
  body: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!parsePRUrl(prUrl)) {
    return { ok: false, error: "Invalid PR URL" };
  }
  const trimmedBody = (body || "").trim();
  const flag =
    decision === "approve"
      ? "--approve"
      : decision === "request-changes"
        ? "--request-changes"
        : "--comment";
  const args = ["pr", "review", prUrl, flag];
  if (trimmedBody) {
    args.push("--body", trimmedBody);
  } else if (decision !== "approve") {
    return { ok: false, error: "A review body is required for this decision." };
  }
  const result = await execFileResult("gh", args);
  if (!result.ok) {
    const msg = (result.stderr || result.stdout || "Unknown error").trim();
    return { ok: false, error: msg };
  }
  return { ok: true };
}
