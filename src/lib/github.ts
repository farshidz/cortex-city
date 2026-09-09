import { conversationKey, type ReviewConversationItem } from "./review-conversation";
import { exec as execCb, execFile as execFileCb } from "child_process";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import * as lockfile from "proper-lockfile";
import {
  isReviewerAuthoredCommentBody,
  REVIEWER_GITHUB_COMMENT_PREFIX,
  REVIEWER_HUMAN_DECISION_COMMENT_PREFIX,
  REVIEWER_SELF_APPROVAL_COMMENT_PREFIX,
  reviewerCommentBodySha256,
  reviewerCommentSurfaceOf,
  reviewerHumanDecisionCommentMarker,
} from "./review-comments";
import { getReviewSummary } from "./review-store";
import type {
  PRStatus,
  ReviewerCommentCancellation,
  ReviewerCommentDelivery,
  ReviewerCommentReceipt,
  ReviewerCommentSurface,
  ReviewerThreadSummary,
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

const GITHUB_RATE_LIMIT_INITIAL_BACKOFF_MS = 60_000;
const GITHUB_RATE_LIMIT_MAX_BACKOFF_MS = 15 * 60_000;
let githubRateLimitBlockedUntil = 0;
let githubRateLimitNextBackoffMs = GITHUB_RATE_LIMIT_INITIAL_BACKOFF_MS;

function isGitHubRateLimitError(message: string): boolean {
  return /rate.?limit|secondary rate/i.test(message);
}

function activeGitHubRateLimitBackoff(): string | undefined {
  if (Date.now() >= githubRateLimitBlockedUntil) return undefined;
  return `GitHub rate-limit backoff is active until ${new Date(
    githubRateLimitBlockedUntil
  ).toISOString()}.`;
}

function recordGitHubRateLimit(): void {
  const now = Date.now();
  if (now < githubRateLimitBlockedUntil) return;
  githubRateLimitBlockedUntil = now + githubRateLimitNextBackoffMs;
  githubRateLimitNextBackoffMs = Math.min(
    githubRateLimitNextBackoffMs * 2,
    GITHUB_RATE_LIMIT_MAX_BACKOFF_MS
  );
  console.error(
    `[github] Rate limited; backing off until ${new Date(
      githubRateLimitBlockedUntil
    ).toISOString()}`
  );
}

function recordSuccessfulGitHubRequest(): void {
  if (Date.now() < githubRateLimitBlockedUntil) return;
  githubRateLimitBlockedUntil = 0;
  githubRateLimitNextBackoffMs = GITHUB_RATE_LIMIT_INITIAL_BACKOFF_MS;
}

interface StatusCheckRollupItem {
  name?: string;
  state?: string;
}

export interface GitHubPRSnapshot {
  pr_url: string;
  state: "open" | "merged" | "closed";
  head_sha: string;
  base_branch: string;
  merge_commit_sha?: string;
  pr_status: PRStatus;
  checks_state: string;
  updated_at: string;
  // Changes when a head, check, review, conversation activity, base, or
  // lifecycle field visible to the batch query changes.
  observation_key: string;
}

interface GraphQLCheckNode {
  __typename?: "CheckRun" | "StatusContext";
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
}

interface GraphQLSnapshotNode {
  state?: string;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string } | null;
  headRefOid?: string;
  baseRefName?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  updatedAt?: string;
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          contexts?: {
            nodes?: GraphQLCheckNode[];
            pageInfo?: { hasNextPage?: boolean };
          };
        } | null;
      };
    }>;
  };
  reviews?: {
    nodes?: Array<{
      databaseId?: number;
      state?: string;
      submittedAt?: string | null;
      commit?: { oid?: string } | null;
    }>;
  };
  comments?: {
    nodes?: Array<{
      databaseId?: number;
      updatedAt?: string;
    }>;
  };
}

interface GraphQLResponseError {
  path?: Array<string | number>;
}

interface ReviewCommentItem {
  updated_at?: string;
  id: number;
  pull_request_review_id: number | null;
  body?: string | null;
  user?: { login?: string };
  created_at?: string;
}

interface ReviewItem {
  updated_at?: string;
  id: number;
  state?: string;
  body?: string | null;
  user?: { login?: string };
  submitted_at?: string;
}

interface IssueCommentItem {
  updated_at?: string;
  id: number;
  body?: string | null;
  user?: { login?: string };
  created_at?: string;
}

interface ReviewerCommentDeliveryTarget {
  state?: string;
  merged?: boolean;
  head?: { sha?: string };
}

const REVIEWER_COMMENT_DELIVERY_LOCK_DIR = path.join(
  tmpdir(),
  "cortex-city-reviewer-comment-delivery-locks"
);
const REVIEWER_COMMENT_DELIVERY_LOCK_STALE_MS = 120_000;

export class StaleReviewerCommentDeliveryError extends Error {
  constructor(
    readonly reason: ReviewerCommentCancellation["reason"],
    readonly expectedHeadSha: string,
    readonly observedHeadSha: string | undefined,
    readonly observedPRState: string
  ) {
    super(
      reason === "head_changed"
        ? `Reviewer comment delivery was canceled because PR HEAD moved from ${expectedHeadSha} to ${observedHeadSha || "an unknown commit"}.`
        : `Reviewer comment delivery was canceled because the PR is ${observedPRState}.`
    );
    this.name = "StaleReviewerCommentDeliveryError";
  }
}

export function isStaleReviewerCommentDeliveryError(
  error: unknown
): error is StaleReviewerCommentDeliveryError {
  return error instanceof StaleReviewerCommentDeliveryError;
}

export function reviewerCommentCancellationFromStaleError(
  delivery: ReviewerCommentDelivery,
  error: StaleReviewerCommentDeliveryError
): ReviewerCommentCancellation {
  return {
    action_token: delivery.action_token,
    reason: error.reason,
    expected_head_sha: error.expectedHeadSha,
    observed_head_sha: error.observedHeadSha,
    observed_pr_state: error.observedPRState,
    body_sha256: reviewerCommentBodySha256(delivery.body),
    canceled_at: new Date().toISOString(),
  };
}

// Everything needed to recognize a comment the reviewer itself posted. A
// receipted (surface, id) pair is proof; the prefix is the fallback for
// comments a run failed to record, and it only counts together with the
// signed-in author so a participant copying the marker cannot hide from the
// state hash.
interface ReviewerCommentIdentity {
  issueIds: Set<number>;
  reviewCommentIds: Set<number>;
  authorLogin: string;
}

function receiptedReviewerCommentIds(
  prUrl: string
): Pick<ReviewerCommentIdentity, "issueIds" | "reviewCommentIds"> {
  const review = getReviewSummary(prUrl);
  const issueIds = new Set<number>();
  const reviewCommentIds = new Set<number>();
  for (const receipt of review?.reviewer_comment_receipts || []) {
    if (reviewerCommentSurfaceOf(receipt) === "review_comment") {
      reviewCommentIds.add(receipt.comment_id);
    } else {
      issueIds.add(receipt.comment_id);
    }
  }
  return { issueIds, reviewCommentIds };
}

async function reviewerCommentIdentity(
  prUrl: string,
  candidates: Array<{ body?: string | null }>
): Promise<ReviewerCommentIdentity> {
  const receipted = receiptedReviewerCommentIds(prUrl);
  // Resolving the signed-in user costs a GitHub call. Skip it unless some body
  // actually carries the reviewer prefix and could need the fallback.
  const needsAuthor = candidates.some((candidate) =>
    isReviewerAuthoredCommentBody(candidate.body)
  );
  let authorLogin = "";
  if (needsAuthor) {
    try {
      authorLogin = (await getAuthenticatedUserLogin()).trim();
    } catch {
      authorLogin = "";
    }
  }
  return { ...receipted, authorLogin };
}

function isReviewerAuthoredComment(
  identity: ReviewerCommentIdentity,
  surface: ReviewerCommentSurface,
  comment: { id: number; body?: string | null; user?: { login?: string } }
): boolean {
  const receiptedIds =
    surface === "review_comment"
      ? identity.reviewCommentIds
      : identity.issueIds;
  if (receiptedIds.has(comment.id)) return true;
  if (!identity.authorLogin) return false;
  if (comment.user?.login !== identity.authorLogin) return false;
  return isReviewerAuthoredCommentBody(comment.body);
}

// A review the reviewer generated as a side effect of commenting: GitHub wraps
// each inline comment in a COMMENTED review with an empty body. Such a review
// carries no information the comments themselves do not, so it is excluded once
// every comment it owns is reviewer-authored. Decisive reviews (APPROVED,
// CHANGES_REQUESTED, DISMISSED) are never excluded.
function reviewerAuthoredReviewIds(
  identity: ReviewerCommentIdentity,
  reviews: ReviewItem[],
  comments: ReviewCommentItem[]
): Set<number> {
  const excluded = new Set<number>();
  if (!identity.authorLogin) return excluded;
  for (const review of reviews) {
    if (review.user?.login !== identity.authorLogin) continue;
    if ((review.state || "").toUpperCase() !== "COMMENTED") continue;
    if ((review.body || "").trim()) {
      if (isReviewerAuthoredCommentBody(review.body)) excluded.add(review.id);
      continue;
    }
    const owned = comments.filter(
      (comment) => comment.pull_request_review_id === review.id
    );
    if (
      owned.length > 0 &&
      owned.every((comment) =>
        isReviewerAuthoredComment(identity, "review_comment", comment)
      )
    ) {
      excluded.add(review.id);
    }
  }
  return excluded;
}

function parsePRUrl(url: string): PRInfo | null {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

const PR_SNAPSHOT_BATCH_SIZE = 50;

const PR_SNAPSHOT_FIELDS = `
  state
  mergedAt
  mergeCommit { oid }
  headRefOid
  baseRefName
  mergeable
  mergeStateStatus
  updatedAt
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
            pageInfo { hasNextPage }
          }
        }
      }
    }
  }
  reviews(last: 1) {
    nodes { databaseId state submittedAt commit { oid } }
  }
  comments(last: 1) {
    nodes { databaseId updatedAt }
  }
`;

interface SnapshotTarget extends PRInfo {
  url: string;
  repoAlias: string;
  prAlias: string;
}

function buildPRSnapshotQuery(targets: SnapshotTarget[]): string {
  const repositories = new Map<string, SnapshotTarget[]>();
  for (const target of targets) {
    const key = `${target.owner}/${target.repo}`;
    const current = repositories.get(key) || [];
    current.push(target);
    repositories.set(key, current);
  }

  const fields = [...repositories.values()].map((repoTargets) => {
    const first = repoTargets[0];
    const pullRequests = repoTargets
      .map(
        (target) =>
          `${target.prAlias}:pullRequest(number:${target.number}){${PR_SNAPSHOT_FIELDS}}`
      )
      .join("\n");
    return `${first.repoAlias}:repository(owner:${JSON.stringify(first.owner)},name:${JSON.stringify(first.repo)}){${pullRequests}}`;
  });
  return `query CortexCityPullRequestSnapshots {${fields.join("\n")}}`;
}

function snapshotCheckState(node: GraphQLSnapshotNode): {
  serialized: string;
  pending: boolean;
  complete: boolean;
} {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (rollup === null) {
    return { serialized: "", pending: false, complete: true };
  }

  const contexts = rollup?.contexts;
  const nodes = contexts?.nodes;
  const complete =
    Array.isArray(nodes) &&
    typeof contexts?.pageInfo?.hasNextPage === "boolean" &&
    !contexts.pageInfo.hasNextPage &&
    nodes.every((check) => {
      if (check.__typename === "CheckRun") {
        return (
          typeof check.name === "string" &&
          check.name.length > 0 &&
          typeof check.status === "string" &&
          check.status.length > 0 &&
          Object.prototype.hasOwnProperty.call(check, "conclusion") &&
          (check.conclusion === null || typeof check.conclusion === "string")
        );
      }
      return (
        check.__typename === "StatusContext" &&
        typeof check.context === "string" &&
        check.context.length > 0 &&
        typeof check.state === "string" &&
        check.state.length > 0
      );
    });
  const checks = (complete ? nodes : [])
    .map((check) => {
      if (check.__typename === "CheckRun") {
        return {
          name: check.name || "",
          state:
            check.status === "COMPLETED"
              ? check.conclusion || "COMPLETED"
              : check.status || "UNKNOWN",
          pending: check.status !== "COMPLETED",
        };
      }
      return {
        name: check.context || "",
        state: check.state || "UNKNOWN",
        pending: check.state === "PENDING" || check.state === "EXPECTED",
      };
    });
  return {
    serialized: serializeCheckStates(checks),
    pending: checks.some((check) => check.pending),
    complete,
  };
}

function snapshotPRStatus(
  node: GraphQLSnapshotNode,
  checks: ReturnType<typeof snapshotCheckState>
): PRStatus {
  if (checks.pending) return "checks_pending";
  if (!checks.complete) return "unknown";

  switch ((node.mergeStateStatus || "").toUpperCase()) {
    case "CLEAN":
      return "clean";
    case "DIRTY":
      return "conflicts";
    case "UNSTABLE":
      return "unstable";
    case "BLOCKED":
      return (node.mergeable || "").toUpperCase() === "MERGEABLE"
        ? "needs_approval"
        : "checks_failing";
    default:
      return "unknown";
  }
}

function parseSnapshot(
  target: SnapshotTarget,
  node: GraphQLSnapshotNode
): GitHubPRSnapshot | undefined {
  const headSha = (node.headRefOid || "").trim();
  const checks = snapshotCheckState(node);
  const state = (node.state || "").toUpperCase();
  if (
    !["OPEN", "CLOSED", "MERGED"].includes(state) ||
    typeof node.headRefOid !== "string" ||
    !node.headRefOid.trim() ||
    typeof node.baseRefName !== "string" ||
    !node.baseRefName.trim() ||
    typeof node.mergeable !== "string" ||
    !node.mergeable ||
    typeof node.mergeStateStatus !== "string" ||
    !node.mergeStateStatus ||
    typeof node.updatedAt !== "string" ||
    !node.updatedAt ||
    !Object.prototype.hasOwnProperty.call(node, "mergedAt") ||
    (node.mergedAt !== null && typeof node.mergedAt !== "string") ||
    !Object.prototype.hasOwnProperty.call(node, "mergeCommit") ||
    (node.mergeCommit !== null &&
      (typeof node.mergeCommit?.oid !== "string" || !node.mergeCommit.oid)) ||
    !checks.complete ||
    !Array.isArray(node.reviews?.nodes) ||
    node.reviews.nodes.length > 1 ||
    !node.reviews.nodes.every(
      (review) =>
        typeof review.databaseId === "number" &&
        typeof review.state === "string" &&
        Boolean(review.state) &&
        Object.prototype.hasOwnProperty.call(review, "submittedAt") &&
        (review.submittedAt === null ||
          typeof review.submittedAt === "string") &&
        Object.prototype.hasOwnProperty.call(review, "commit") &&
        (review.commit === null ||
          (typeof review.commit?.oid === "string" && Boolean(review.commit.oid)))
    ) ||
    !Array.isArray(node.comments?.nodes) ||
    node.comments.nodes.length > 1 ||
    !node.comments.nodes.every(
      (comment) =>
        typeof comment.databaseId === "number" &&
        typeof comment.updatedAt === "string" &&
        Boolean(comment.updatedAt)
    )
  ) {
    return undefined;
  }
  const lifecycleState: GitHubPRSnapshot["state"] =
    node.mergedAt || state === "MERGED"
      ? "merged"
      : state === "CLOSED"
        ? "closed"
        : "open";
  const observation = {
    state: lifecycleState,
    head_sha: headSha,
    base_branch: (node.baseRefName || "").trim(),
    merge_commit_sha: node.mergeCommit?.oid || "",
    mergeable: node.mergeable || "",
    merge_state_status: node.mergeStateStatus || "",
    updated_at: node.updatedAt || "",
    checks: checks.serialized,
    latest_review: node.reviews?.nodes?.[0] || null,
    latest_comment: node.comments?.nodes?.[0] || null,
  };
  return {
    pr_url: target.url,
    state: lifecycleState,
    head_sha: headSha,
    base_branch: observation.base_branch,
    merge_commit_sha: observation.merge_commit_sha || undefined,
    pr_status: snapshotPRStatus(node, checks),
    checks_state: checks.serialized,
    updated_at: observation.updated_at,
    observation_key: createHash("sha256")
      .update(JSON.stringify(observation))
      .digest("hex")
      .slice(0, 16),
  };
}

// Resolve the cheap fields needed by every worker poll in one GraphQL request
// for the normal task set. Larger sets are split to keep query cost and node
// count bounded.
export async function getPRSnapshots(
  prUrls: string[]
): Promise<Record<string, GitHubPRSnapshot>> {
  const parsed = [...new Set(prUrls)]
    .map((url) => ({ url, parsed: parsePRUrl(url) }))
    .filter(
      (entry): entry is { url: string; parsed: PRInfo } => entry.parsed !== null
    );
  const snapshots: Record<string, GitHubPRSnapshot> = {};

  for (let offset = 0; offset < parsed.length; offset += PR_SNAPSHOT_BATCH_SIZE) {
    const chunk = parsed.slice(offset, offset + PR_SNAPSHOT_BATCH_SIZE);
    const repoAliases = new Map<string, string>();
    const targets: SnapshotTarget[] = chunk.map((entry, index) => {
      const repoKey = `${entry.parsed.owner}/${entry.parsed.repo}`;
      let repoAlias = repoAliases.get(repoKey);
      if (!repoAlias) {
        repoAlias = `r${repoAliases.size}`;
        repoAliases.set(repoKey, repoAlias);
      }
      return {
        ...entry.parsed,
        url: entry.url,
        repoAlias,
        prAlias: `p${index}`,
      };
    });
    const result = await execFileResult("gh", [
      "api",
      "graphql",
      "-f",
      `query=${buildPRSnapshotQuery(targets)}`,
    ]);
    // GitHub returns partial GraphQL data alongside errors when one requested
    // PR is missing. Keep the valid snapshots instead of discarding the whole
    // batch because `gh` used a non-zero exit code for that partial response.
    if (!result.stdout.trim()) {
      throw new Error(result.stderr.trim() || "Failed to fetch PR snapshots.");
    }

    let data: Record<string, Record<string, GraphQLSnapshotNode | null> | null>;
    let errors: GraphQLResponseError[] = [];
    try {
      const parsedResponse = JSON.parse(result.stdout) as {
        data?: Record<string, Record<string, GraphQLSnapshotNode | null> | null>;
        errors?: GraphQLResponseError[];
      };
      if (!parsedResponse.data) throw new Error("GitHub returned no data");
      data = parsedResponse.data;
      errors = Array.isArray(parsedResponse.errors) ? parsedResponse.errors : [];
    } catch (error) {
      throw new Error(
        `Failed to parse PR snapshot response: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    for (const target of targets) {
      const hasGraphQLError = errors.some((error) => {
        if (!Array.isArray(error.path)) return true;
        const repoIndex = error.path.indexOf(target.repoAlias);
        if (repoIndex < 0) return false;
        const prPath = error.path[repoIndex + 1];
        return prPath === undefined || prPath === target.prAlias;
      });
      if (hasGraphQLError) continue;
      const node = data[target.repoAlias]?.[target.prAlias];
      if (!node) continue;
      const snapshot = parseSnapshot(target, node);
      if (snapshot) snapshots[target.url] = snapshot;
    }
  }

  return snapshots;
}

function execResult(cmd: string): Promise<ExecResult> {
  const backoffError = activeGitHubRateLimitBackoff();
  if (backoffError) {
    return Promise.resolve({ ok: false, output: "", error: backoffError });
  }
  return new Promise((resolve) => {
    execCb(cmd, { encoding: "utf-8", timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "").trim();
        if (isGitHubRateLimitError(msg)) {
          recordGitHubRateLimit();
        } else if (msg) {
          console.error(`[github] Command failed: ${cmd.slice(0, 80)} — ${msg.slice(0, 200)}`);
        }
        resolve({ ok: false, output: "", error: msg });
        return;
      }
      recordSuccessfulGitHubRequest();
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

interface PRActivity {
  reviews: ReviewItem[] | null;
  comments: ReviewCommentItem[] | null;
  issueComments: IssueCommentItem[] | null;
}

const PR_ACTIVITY_CACHE_MAX_ENTRIES = 512;
const prActivityCache = new Map<
  string,
  { observationKey: string; activity: PRActivity }
>();

function cachePRActivity(
  prUrl: string,
  observationKey: string,
  activity: PRActivity
): void {
  prActivityCache.delete(prUrl);
  prActivityCache.set(prUrl, { observationKey, activity });
  while (prActivityCache.size > PR_ACTIVITY_CACHE_MAX_ENTRIES) {
    const oldest = prActivityCache.keys().next().value;
    if (typeof oldest !== "string") break;
    prActivityCache.delete(oldest);
  }
}

async function getPRActivity(
  prUrl: string,
  observationKey?: string,
  scope: "reviews" | "all" = "all"
): Promise<PRActivity | null> {
  const cached = observationKey ? prActivityCache.get(prUrl) : undefined;
  const matchingCache =
    cached && cached.observationKey === observationKey
      ? cached.activity
      : undefined;
  const hasRequestedSurfaces =
    scope === "reviews"
      ? Boolean(matchingCache?.reviews)
      : Boolean(
          matchingCache?.reviews &&
            matchingCache.comments &&
            matchingCache.issueComments
        );
  if (cached && hasRequestedSurfaces) {
    // Refresh insertion order so the bounded map behaves as an LRU cache.
    prActivityCache.delete(prUrl);
    prActivityCache.set(prUrl, cached);
    return cached.activity;
  }

  const pr = parsePRUrl(prUrl);
  if (!pr) return null;
  const [reviews, comments, issueComments] = await Promise.all([
    matchingCache?.reviews
      ? Promise.resolve(matchingCache.reviews)
      : execPaginatedArrayStrict<ReviewItem>(
          `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
        ),
    scope === "reviews" || matchingCache?.comments
      ? Promise.resolve(matchingCache?.comments || null)
      : execPaginatedArrayStrict<ReviewCommentItem>(
          `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`
        ),
    scope === "reviews" || matchingCache?.issueComments
      ? Promise.resolve(matchingCache?.issueComments || null)
      : execPaginatedArrayStrict<IssueCommentItem>(
          `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`
        ),
  ]);
  const activity = { reviews, comments, issueComments };
  if (observationKey) {
    cachePRActivity(prUrl, observationKey, activity);
  }
  return activity;
}

function serializeCheckStates(checks: StatusCheckRollupItem[]): string {
  return checks
    .filter((check) => typeof check.name === "string" && typeof check.state === "string")
    .map((check) => `${check.name}=${check.state}`)
    .sort()
    .join(",");
}

function parseCheckStates(raw: string): StatusCheckRollupItem[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (check) =>
          check !== null &&
          typeof check === "object" &&
          typeof (check as StatusCheckRollupItem).name === "string" &&
          typeof (check as StatusCheckRollupItem).state === "string"
      )
    ) {
      return null;
    }
    return parsed as StatusCheckRollupItem[];
  } catch {
    return null;
  }
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

// Reduce a unified diff to the content that decides whether it is the same
// change, following `git patch-id --stable`: file identity and mode transitions,
// plus every hunk body line — context included — with whitespace stripped, and
// with blob hashes and hunk headers dropped. Dropping only the line numbers is
// what makes the identity survive a rebase; keeping context is what keeps two
// identical edits in different places apart.
//
// Returning "" means the diff cannot be identified, which is the fail-closed
// answer: callers then fall back to head SHAs and review again rather than
// treating two unknowns as the same change. A binary diff is exactly that case —
// `gh pr diff` reports only that the files differ, so no revision of a binary is
// distinguishable from any other.
function normalizedDiffIdentity(diff: string): string | undefined {
  const parts: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      return undefined;
    }
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ")
    ) {
      parts.push(line.trim());
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@") ||
      line.startsWith("similarity index ") ||
      line.startsWith("\\")
    ) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      const stripped = line.slice(1).replace(/\s+/g, "");
      // A blank context line carries nothing and its presence shifts with
      // reformatting, so only its marker would be recorded. Skip it.
      if (line.startsWith(" ") && !stripped) continue;
      parts.push(`${line[0]}${stripped}`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function reviewDiffIdentityHash(diff: string): string {
  const normalized = normalizedDiffIdentity(diff);
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export async function getPRDiffHash(
  prUrl: string,
  // The head this identity is about to be recorded against. `gh pr diff`
  // resolves whatever the PR points at when it runs, so without this a head move
  // mid-poll would tag the new head's diff onto the old identity, or the reverse.
  expectedHeadSha?: string
): Promise<string> {
  if (!parsePRUrl(prUrl)) return "";
  const result = await execFileResult("gh", ["pr", "diff", prUrl]);
  if (!result.ok) return "";
  const hash = reviewDiffIdentityHash(result.stdout);
  if (!hash || !expectedHeadSha) return hash;
  // Confirm the target held still across the read. An unreadable or moved head
  // yields no identity, which schedules a review instead of trusting this one.
  const observedHeadSha = await getPRHeadSha(prUrl);
  return observedHeadSha === expectedHeadSha ? hash : "";
}

// Snapshot published discussion with content versions. Reuse the same provenance
// rules as the scheduling clock, but include edits and review-state changes.
const conversationScanCache = new Map<string, {
  observationKey: string;
  receiptsKey: string;
  items: ReviewConversationItem[];
  pageCount: number;
  refreshAfter: number;
}>();
const CONVERSATION_SCAN_CACHE_SIZE = 128;

export async function getReviewConversation(prUrl: string, observationKey?: string): Promise<ReviewConversationItem[] | undefined> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return undefined;
  const cached = observationKey ? conversationScanCache.get(prUrl) : undefined;
  const receipts = receiptedReviewerCommentIds(prUrl);
  const receiptsKey = JSON.stringify([[...receipts.issueIds], [...receipts.reviewCommentIds]]);
  const matches = cached?.observationKey === observationKey && cached?.receiptsKey === receiptsKey;
  if (cached && matches && Date.now() < cached.refreshAfter) return cached.items;
  let pageBudget = Infinity;
  if (observationKey) {
    // Background scans leave capacity for active reviews and other GitHub work.
    // Run-start/end snapshots omit observationKey and always read fresh versions.
    const quota = await execFileResult("gh", ["api", "rate_limit"]);
    try {
      const remaining = JSON.parse(quota.stdout).resources.core.remaining;
      if (!quota.ok || !Number.isFinite(remaining)) return undefined;
      pageBudget = Math.max(0, remaining - 100);
      if (pageBudget < (cached?.pageCount ?? 3)) return matches ? cached?.items : undefined;
    } catch { return undefined; }
  }
  const items: ReviewConversationItem[] = [];
  const submittedIds = new Set<number>();
  let retainedBodyBytes = 0;
  let pageCount = 0;
  const add = (surface: ReviewConversationItem["surface"], item: { id: number; body?: string | null; created_at?: string; updated_at?: string; submitted_at?: string; state?: string }) => {
    const body = item.body || "";
    const state = surface === "review" ? item.state || "" : "";
    const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    const omitBody = bytes > 8_000 || retainedBodyBytes + bytes > 24_000;
    if (!omitBody) retainedBodyBytes += bytes;
    items.push({ key: conversationKey(surface, item.id, body, state), surface, id: item.id, body: omitBody ? "" : body, ...(omitBody ? {body_omitted: true} : {}), state, updated_at: item.updated_at || item.submitted_at || item.created_at || "" });
  };
  async function* pages<T>(endpoint: string): AsyncGenerator<T[]> {
    for (let page = 1; ; page++) {
      // Ten bodies fit in a bounded subprocess buffer, including JSON escaping.
      // Only this page's full bodies are retained while computing their hashes.
      if (pageCount >= pageBudget) throw new Error("Conversation background scan quota exhausted");
      pageCount++;
      const result = await execFileResult("gh", ["api", `${endpoint}?per_page=10&page=${page}`], 8 * 1024 * 1024);
      if (!result.ok) throw new Error("Conversation page unavailable");
      const rows: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(rows) || rows.length > 10) throw new Error("Invalid conversation page");
      yield rows as T[];
      if (rows.length < 10) return;
    }
  }
  try {
    for await (const reviews of pages<ReviewItem>(`repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`)) {
      const identity = await reviewerCommentIdentity(prUrl, reviews);
      for (const review of reviews) {
        if (review.state === "PENDING") continue;
        submittedIds.add(review.id);
        if (!(review.body || "").trim()) continue;
        if (identity.authorLogin && review.user?.login === identity.authorLogin && isReviewerAuthoredCommentBody(review.body)) continue;
        add("review", review);
      }
    }
    const reviewCount = items.length;
    for await (const comments of pages<ReviewCommentItem>(`repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`)) {
      const identity = await reviewerCommentIdentity(prUrl, comments);
      for (const comment of comments) {
        if (isCommentFromSubmittedReview(comment, submittedIds) && !isReviewerAuthoredComment(identity, "review_comment", comment)) add("review_comment", comment);
      }
    }
    for await (const comments of pages<IssueCommentItem>(`repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`)) {
      const identity = await reviewerCommentIdentity(prUrl, comments);
      for (const comment of comments) {
        if (!isReviewerAuthoredComment(identity, "issue", comment)) add("issue", comment);
      }
    }
    const ordered = [...items.slice(reviewCount), ...items.slice(0, reviewCount)];
    if (observationKey) {
      conversationScanCache.delete(prUrl);
      conversationScanCache.set(prUrl, {
        observationKey, receiptsKey, items: ordered, pageCount,
        // Small discussions refresh after five minutes for older edits that do
        // not change observationKey. Large scans amortize ten seconds per page.
        refreshAfter: Date.now() + Math.max(5 * 60_000, pageCount * 10_000),
      });
      while (conversationScanCache.size > CONVERSATION_SCAN_CACHE_SIZE) {
        conversationScanCache.delete(conversationScanCache.keys().next().value!);
      }
    }
    return ordered;
  } catch {
    return undefined;
  }
}

// The newest published conversation on this PR that the reviewer did not author,
// or "" when there is none and when GitHub could not answer. Drives the
// reply-round trigger, so a reviewer comment never counts as someone talking to
// it, an unsubmitted draft never counts as published, and a submitted review
// whose feedback is only in its body is not missed.
export async function getLatestForeignCommentAt(
  prUrl: string,
  observationKey?: string
): Promise<string> {
  const activity = await getPRActivity(prUrl, observationKey);
  if (
    !activity?.reviews ||
    !activity.comments ||
    !activity.issueComments
  ) {
    return "";
  }
  const { reviews, comments, issueComments } = activity;

  const identity = await reviewerCommentIdentity(prUrl, [
    ...comments,
    ...issueComments,
    ...reviews,
  ]);
  const submittedIds = new Set(
    reviews
      .filter((review) => review.state !== "PENDING")
      .map((review) => review.id)
  );
  let latest = "";
  let latestMs = -Infinity;
  const consider = (timestamp?: string) => {
    const at = (timestamp || "").trim();
    const atMs = at ? new Date(at).getTime() : NaN;
    if (!Number.isFinite(atMs) || atMs <= latestMs) return;
    latest = at;
    latestMs = atMs;
  };
  const considerComments = (
    surface: ReviewerCommentSurface,
    items: Array<{
      id: number;
      body?: string | null;
      user?: { login?: string };
      created_at?: string;
    }>
  ) => {
    for (const item of items) {
      if (isReviewerAuthoredComment(identity, surface, item)) continue;
      consider(item.created_at);
    }
  };
  // An inline comment counts only once its owning review is submitted, which is
  // the same contract the PR state hash uses.
  considerComments(
    "review_comment",
    comments.filter((comment) =>
      isCommentFromSubmittedReview(comment, submittedIds)
    )
  );
  considerComments("issue", issueComments);
  for (const review of reviews) {
    if (review.state === "PENDING") continue;
    if (!(review.body || "").trim()) continue;
    if (
      identity.authorLogin &&
      review.user?.login === identity.authorLogin &&
      isReviewerAuthoredCommentBody(review.body)
    ) {
      continue;
    }
    consider(review.submitted_at);
  }
  return latest;
}

interface ReviewThreadNode {
  id?: string;
  isResolved?: boolean;
  comments?: {
    nodes?: Array<{
      databaseId?: number;
      body?: string | null;
      url?: string;
      author?: { login?: string };
    }>;
  };
}

const UNRESOLVED_REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          id
          isResolved
          comments(first:1){ nodes{ databaseId body url author{ login } } }
        }
      }
    }
  }
}`;

function firstLineOf(body: string | null | undefined): string {
  const line = (body || "")
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(Boolean);
  if (!line) return "(no text)";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

// The reviewer's own unresolved review threads, as pointers. A tier-1
// verification round is seeded with this list instead of a transcript, so it
// starts from its open findings and pulls the bodies itself.
export async function listUnresolvedReviewerThreads(
  prUrl: string
): Promise<ReviewerThreadSummary[]> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return [];

  const result = await execFileResult("gh", [
    "api",
    "graphql",
    "-f",
    `query=${UNRESOLVED_REVIEW_THREADS_QUERY}`,
    "-F",
    `owner=${pr.owner}`,
    "-F",
    `repo=${pr.repo}`,
    "-F",
    `number=${pr.number}`,
  ]);
  if (!result.ok || !result.stdout.trim()) return [];

  let nodes: ReviewThreadNode[] = [];
  try {
    const parsed = JSON.parse(result.stdout) as {
      data?: {
        repository?: {
          pullRequest?: { reviewThreads?: { nodes?: ReviewThreadNode[] } };
        };
      };
    };
    nodes = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  } catch {
    return [];
  }
  if (nodes.length === 0) return [];

  const identity = await reviewerCommentIdentity(
    prUrl,
    nodes.map((node) => ({ body: node.comments?.nodes?.[0]?.body }))
  );
  const threads: ReviewerThreadSummary[] = [];
  for (const node of nodes) {
    if (!node.id || node.isResolved) continue;
    const first = node.comments?.nodes?.[0];
    if (!first) continue;
    const authored = isReviewerAuthoredComment(identity, "review_comment", {
      id: typeof first.databaseId === "number" ? first.databaseId : -1,
      body: first.body,
      user: { login: first.author?.login },
    });
    if (!authored) continue;
    threads.push({
      thread_id: node.id,
      url: first.url,
      first_line: firstLineOf(first.body),
    });
  }
  return threads;
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

export async function getPRBaseBranch(prUrl: string): Promise<string> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return "";

  const data = await execJson<{ baseRefName?: string }>(
    `gh pr view ${prUrl} --json baseRefName`
  );
  return data?.baseRefName?.trim() || "";
}

export async function getPRMergeCommitSha(prUrl: string): Promise<string> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return "";

  const result = await execResult(
    `gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number} --jq '.merge_commit_sha // ""'`
  );
  if (!result.ok) {
    throw new Error(result.error || "Failed to read the PR merge commit.");
  }
  return result.output.trim();
}

// The merge base is the immutable cutoff between a stacked PR and the entry
// below it. Capture it before either branch is rewritten so a later serial
// restack can replay only the upper PR's commits.
export async function getCommitMergeBaseSha(
  repoSlug: string,
  baseSha: string,
  headSha: string
): Promise<string> {
  const slug = repoSlug.trim();
  if (!slug || !baseSha.trim() || !headSha.trim()) return "";

  const result = await execResult(
    `gh api repos/${slug}/compare/${baseSha.trim()}...${headSha.trim()} --jq '.merge_base_commit.sha // ""'`
  );
  if (!result.ok) return "";
  return result.output.trim();
}

// True when `ancestorSha` is reachable from `descendantSha` in the repo's
// history — GitHub's compare status is "ahead" (or "identical") exactly when
// the base commit is an ancestor of the head commit. Returns null when GitHub
// could not answer, so callers keep a pending obligation instead of clearing
// it on an error.
export async function isCommitAncestor(
  repoSlug: string,
  ancestorSha: string,
  descendantSha: string
): Promise<boolean | null> {
  const slug = repoSlug.trim();
  if (!slug || !ancestorSha.trim() || !descendantSha.trim()) return null;

  const result = await execResult(
    `gh api repos/${slug}/compare/${ancestorSha.trim()}...${descendantSha.trim()} --jq .status`
  );
  if (!result.ok) return null;
  const status = result.output.trim();
  if (status === "ahead" || status === "identical") return true;
  if (status === "behind" || status === "diverged") return false;
  return null;
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

  const identity = await reviewerCommentIdentity(prUrl, [
    ...comments,
    ...issueComments,
  ]);

  // `/pulls/{n}/comments` is the inline-review surface. PR conversation
  // comments come from `/issues/{n}/comments`; review-id-null inline comments
  // can be draft review artifacts and must not trigger review runs.
  const reviewCommentIds = comments
    .filter(
      (comment) =>
        isCommentFromSubmittedReview(comment, submittedIds) &&
        !isReviewerAuthoredComment(identity, "review_comment", comment)
    )
    .map((comment) => comment.id);

  const issueCommentIds = issueComments
    .filter((comment) => !isReviewerAuthoredComment(identity, "issue", comment))
    .map((comment) => comment.id);

  return [...reviewCommentIds, ...issueCommentIds].sort();
}

// An unsubmitted review — GitHub's PENDING state, the draft a reviewer builds
// before submitting. It matters because GitHub wraps each inline comment in a
// review of its own and sometimes leaves that review unsubmitted: a PENDING
// review is visible only to its author, GitHub allows one per user per pull
// request, and while it is open every later inline comment the user posts joins
// it instead of publishing. One leaked draft therefore swallows every later
// round's replies, and REST inline posts start failing with "user_id can only
// have one pending review per pull request". Prompts can reduce how often one is
// created; only draining it afterwards repairs the ones that happen anyway.
export type PendingReviewDrainStatus =
  // Nothing pending for the signed-in user.
  | "none"
  // Held only reviewer-authored content; published as a COMMENT review.
  | "submitted"
  // Held no comments and no review body, so there was nothing to publish.
  | "deleted"
  // Holds a comment or a review body Cortex City did not author — someone's
  // review in progress. Left untouched: publishing or discarding another
  // author's draft would destroy unfinished work.
  | "foreign"
  // GitHub could not be read. Nothing is known about a draft either way.
  | "unavailable"
  // A draft was found and the repair call failed.
  | "failed";

export interface PendingReviewDrain {
  status: PendingReviewDrainStatus;
  review_id?: number;
  comment_count?: number;
  // Receipts for the comments the submit published. Publishing makes comments
  // written in earlier rounds visible for the first time, so the caller records
  // them exactly like comments a run posted directly, keeping reviewer-only
  // activity out of the PR state hash.
  receipts?: ReviewerCommentReceipt[];
  error?: string;
}

function pendingReviewSubmitBody(commentCount: number): string {
  // The reviewer prefix is load-bearing: `reviewerAuthoredReviewIds` excludes a
  // COMMENTED review carrying it, so publishing the draft does not change the PR
  // state hash and does not wake the author for the reviewer's own comments.
  return [
    REVIEWER_GITHUB_COMMENT_PREFIX,
    `Publishing ${commentCount} review comment${commentCount === 1 ? "" : "s"}`,
    "that GitHub left in an unsubmitted review. They were written in earlier",
    "rounds and were visible only to the reviewer until now.",
  ].join(" ");
}

// Find the signed-in user's unsubmitted review on a PR and repair it. GitHub
// permits one pending review per user, so this handles a single draft per call;
// a later call drains anything that appears afterwards.
export async function drainMyPendingReview(
  prUrl: string
): Promise<PendingReviewDrain> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return { status: "unavailable", error: "Invalid PR URL" };

  let authorLogin = "";
  try {
    authorLogin = (await getAuthenticatedUserLogin()).trim();
  } catch {
    authorLogin = "";
  }
  if (!authorLogin) {
    return {
      status: "unavailable",
      error: "GitHub did not return the signed-in user.",
    };
  }

  const reviews = await execPaginatedArrayStrict<ReviewItem>(
    `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
  );
  if (!reviews) {
    return {
      status: "unavailable",
      error: "Could not list the pull request's reviews.",
    };
  }
  const pending = reviews.find(
    (review) =>
      (review.state || "").toUpperCase() === "PENDING" &&
      review.user?.login === authorLogin &&
      Number.isSafeInteger(review.id) &&
      review.id > 0
  );
  if (!pending) return { status: "none" };

  const comments = await execPaginatedArrayStrict<ReviewCommentItem>(
    `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews/${pending.id}/comments`
  );
  if (!comments) {
    return {
      status: "failed",
      review_id: pending.id,
      error: `Could not list the comments held by unsubmitted review ${pending.id}.`,
    };
  }

  // A review body is held content in its own right: GitHub lets a pending review
  // carry one independently of its inline comments. Classifying only the comments
  // would delete a body-only draft and overwrite a body on submit, so the body is
  // weighed with the same reviewer-authored test as every comment.
  //
  // The raw body and the trimmed one serve different jobs and must not be mixed:
  // trimming answers "does it hold a body at all", while the value sent back on
  // submit has to be the raw one, or submitting would rewrite trailing Markdown
  // newlines out of a body this code promises to preserve. Ownership stays
  // anchored on the raw body, so a prefix pushed off position 0 by leading
  // whitespace is foreign.
  const rawBody = pending.body || "";
  const heldBody = rawBody.trim();
  const foreignBody = Boolean(heldBody && !isReviewerAuthoredCommentBody(rawBody));

  if (comments.length === 0 && !heldBody) {
    const deleted = await execFileResult("gh", [
      "api",
      "--method",
      "DELETE",
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews/${pending.id}`,
    ]);
    return deleted.ok
      ? { status: "deleted", review_id: pending.id, comment_count: 0 }
      : {
          status: "failed",
          review_id: pending.id,
          comment_count: 0,
          error: `Could not delete empty unsubmitted review ${pending.id}: ${
            (deleted.stderr || deleted.stdout || "Unknown gh error").trim()
          }`,
        };
  }

  const foreignComments = comments.filter(
    (comment) =>
      comment.user?.login !== authorLogin ||
      !isReviewerAuthoredCommentBody(comment.body)
  );
  if (foreignComments.length > 0 || foreignBody) {
    const held = [
      foreignComments.length > 0
        ? `${foreignComments.length} comment(s)`
        : undefined,
      foreignBody ? "a review body" : undefined,
    ]
      .filter(Boolean)
      .join(" and ");
    const reviewerComments = comments.length - foreignComments.length;
    return {
      status: "foreign",
      review_id: pending.id,
      comment_count: comments.length,
      error: [
        `Unsubmitted review ${pending.id} holds ${held} Cortex City did not author, so it was left in place.`,
        "Reviewer comments cannot publish on this PR until its author submits or discards it.",
        reviewerComments > 0
          ? `Discarding it also discards ${reviewerComments} reviewer comment(s) it holds, which a re-review has to regenerate.`
          : undefined,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  const submitted = await execFileResult("gh", [
    "api",
    "--method",
    "POST",
    `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews/${pending.id}/events`,
    "-f",
    "event=COMMENT",
    "-f",
    // Submitting replaces the review body, so a body the reviewer already wrote
    // is passed back byte-for-byte rather than traded for the recovery note or
    // silently normalized.
    `body=${heldBody ? rawBody : pendingReviewSubmitBody(comments.length)}`,
  ]);
  if (!submitted.ok) {
    return {
      status: "failed",
      review_id: pending.id,
      comment_count: comments.length,
      error: `Could not submit unsubmitted review ${pending.id}: ${
        (submitted.stderr || submitted.stdout || "Unknown gh error").trim()
      }`,
    };
  }
  return {
    status: "submitted",
    review_id: pending.id,
    comment_count: comments.length,
    receipts: comments
      .filter((comment) => Number.isSafeInteger(comment.id) && comment.id > 0)
      .map((comment) => ({
        comment_id: comment.id,
        author_login: authorLogin,
        body_sha256: reviewerCommentBodySha256(comment.body || ""),
        surface: "review_comment" as ReviewerCommentSurface,
      })),
  };
}

// Every comment the signed-in user posted with the reviewer prefix, optionally
// limited to those created at or after `since`. The reviewer posts through the
// `gh` CLI inside its own run, so this is how the run's comments become
// receipts: list them afterwards instead of trying to intercept each POST.
export async function listReviewerAuthoredComments(
  prUrl: string,
  since?: string
): Promise<ReviewerCommentReceipt[]> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return [];

  let authorLogin = "";
  try {
    authorLogin = (await getAuthenticatedUserLogin()).trim();
  } catch {
    authorLogin = "";
  }
  if (!authorLogin) return [];

  const [comments, issueComments] = await Promise.all([
    execPaginatedArrayStrict<ReviewCommentItem>(
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`
    ),
    execPaginatedArrayStrict<IssueCommentItem>(
      `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`
    ),
  ]);

  const sinceMs = since ? new Date(since).getTime() : NaN;
  const isInWindow = (createdAt?: string): boolean => {
    if (!Number.isFinite(sinceMs)) return true;
    const createdMs = createdAt ? new Date(createdAt).getTime() : NaN;
    // An unparseable timestamp is receipted rather than dropped: the comment
    // carries the reviewer prefix and the signed-in author either way.
    return !Number.isFinite(createdMs) || createdMs >= sinceMs;
  };

  const receipts: ReviewerCommentReceipt[] = [];
  const collect = (
    surface: ReviewerCommentSurface,
    items: Array<{
      id: number;
      body?: string | null;
      user?: { login?: string };
      created_at?: string;
    }>
  ) => {
    for (const item of items) {
      if (!Number.isSafeInteger(item.id) || item.id <= 0) continue;
      if (item.user?.login !== authorLogin) continue;
      if (!isReviewerAuthoredCommentBody(item.body)) continue;
      if (!isInWindow(item.created_at)) continue;
      receipts.push({
        comment_id: item.id,
        author_login: authorLogin,
        body_sha256: reviewerCommentBodySha256(item.body || ""),
        surface,
      });
    }
  };
  collect("review_comment", comments || []);
  collect("issue", issueComments || []);
  return receipts;
}

export async function getPRStateHash(
  prUrl: string,
  snapshot?: GitHubPRSnapshot
): Promise<string> {
  const pr = parsePRUrl(prUrl);
  if (!pr) return "";

  let headSha = snapshot?.head_sha.trim() || "";
  let ciStatus = snapshot?.checks_state ?? "";
  let activity: PRActivity | null;
  if (snapshot) {
    activity = await getPRActivity(prUrl, snapshot.observation_key);
  } else {
    const [prData, checksResult, fetchedActivity] = await Promise.all([
      execJsonStrict<{
        headRefOid?: string;
        statusCheckRollup?: StatusCheckRollupItem[];
      }>(`gh pr view ${prUrl} --json headRefOid,statusCheckRollup`),
      execResult(`gh pr checks ${prUrl} --json name,state`),
      getPRActivity(prUrl),
    ]);
    if (!prData || typeof prData.headRefOid !== "string") return "";
    headSha = prData.headRefOid.trim();
    if (!checksResult.ok) {
      if (!isNoChecksError(checksResult.error)) return "";
      const checks = Array.isArray(prData.statusCheckRollup)
        ? prData.statusCheckRollup
        : [];
      ciStatus = serializeCheckStates(checks);
    } else {
      const checks = parseCheckStates(checksResult.output);
      if (!checks) return "";
      ciStatus = serializeCheckStates(checks);
    }
    activity = fetchedActivity;
  }
  if (
    !headSha ||
    !activity?.reviews ||
    !activity.comments ||
    !activity.issueComments
  ) {
    return "";
  }
  const { reviews, comments, issueComments } = activity;

  const submittedIds = new Set(
    reviews
      .filter((review) => review.state !== "PENDING")
      .map((review) => review.id)
  );
  // Reviewer-authored activity must not change the hash: it would wake the
  // builder for the reviewer's own comment and read as new conversation to the
  // reviewer itself.
  const identity = await reviewerCommentIdentity(prUrl, [
    ...comments,
    ...issueComments,
    ...reviews,
  ]);
  const filteredCommentIds = JSON.stringify(
    comments
      .filter(
        (comment) =>
          isCommentFromSubmittedReview(comment, submittedIds) &&
          !isReviewerAuthoredComment(identity, "review_comment", comment)
      )
      .map((comment) => comment.id)
      .sort()
  );
  const issueCommentIds = JSON.stringify(
    issueComments
      .filter(
        (comment) => !isReviewerAuthoredComment(identity, "issue", comment)
      )
      .map((comment) => comment.id)
      .sort()
  );
  const reviewerReviewIds = reviewerAuthoredReviewIds(
    identity,
    reviews,
    comments
  );
  const reviewIds = JSON.stringify(
    reviews
      .filter(
        (review) =>
          isHashSignificantReview(review) && !reviewerReviewIds.has(review.id)
      )
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
  login: string,
  observationKey?: string
): Promise<MyReviewSignals> {
  if (!parsePRUrl(prUrl) || !login) return {};
  const activity = await getPRActivity(prUrl, observationKey, "reviews");
  if (!activity?.reviews) return {};
  const reviews = activity.reviews as PRReviewItem[];
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

  let snapshots: Record<string, GitHubPRSnapshot> = {};
  try {
    snapshots = await getPRSnapshots(
      results.map((pr) => (pr.url || "").trim()).filter(Boolean)
    );
  } catch {
    // Keep inbound discovery available if the batch query is temporarily
    // unavailable. The legacy per-PR reads preserve the fail-closed behavior.
    snapshots = {};
  }

  const enriched = await Promise.all(
    results.map(async (pr): Promise<ReviewRequest | null> => {
      const url = (pr.url || "").trim();
      const repoSlug = pr.repository?.nameWithOwner?.trim() || "";
      const parsed = parsePRUrl(url);
      if (!url || !parsed || typeof pr.number !== "number" || !repoSlug) {
        return null;
      }

      const snapshot = snapshots[url];
      const [headSha, signals] = await Promise.all([
        snapshot
          ? Promise.resolve(snapshot.head_sha)
          : execJsonStrict<PRViewResult>(`gh pr view ${url} --json headRefOid`).then(
              (headData) => headData?.headRefOid?.trim() || ""
            ),
        myLogin
          ? getMyReviewSignals(
              url,
              myLogin,
              snapshot?.observation_key
            ).catch(
              (): MyReviewSignals => ({})
            )
          : Promise.resolve<MyReviewSignals>({}),
      ]);

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
        ...(snapshot?.observation_key
          ? { github_observation_key: snapshot.observation_key }
          : {}),
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
  args: string[],
  maxBuffer = 1024 * 1024
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const backoffError = activeGitHubRateLimitBackoff();
  if (backoffError) {
    return Promise.resolve({ ok: false, stdout: "", stderr: backoffError });
  }
  return new Promise((resolve) => {
    execFileCb(
      command,
      args,
      { encoding: "utf-8", timeout: 30000, maxBuffer },
      (err, stdout, stderr) => {
        const errorOutput = (stderr || (err?.message ?? "")).toString();
        if (err && isGitHubRateLimitError(errorOutput)) {
          recordGitHubRateLimit();
        } else if (!err) {
          recordSuccessfulGitHubRequest();
        }
        resolve({
          ok: !err,
          stdout: (stdout || "").toString(),
          stderr: errorOutput,
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
    surface: "issue",
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

async function getReviewerCommentDeliveryTarget(
  pr: PRInfo
): Promise<ReviewerCommentDeliveryTarget> {
  const result = await execFileResult("gh", [
    "api",
    `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
  ]);
  if (!result.ok || !result.stdout.trim()) {
    throw new Error("Failed to verify the reviewer comment PR target.");
  }
  try {
    const parsed = JSON.parse(result.stdout) as ReviewerCommentDeliveryTarget;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.merged !== "boolean" ||
      !parsed.head ||
      typeof parsed.head.sha !== "string" ||
      !parsed.head.sha.trim()
    ) {
      throw new Error("Incomplete GitHub PR target.");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Failed to parse the reviewer comment PR target: ${
        error instanceof Error ? error.message : "unknown GitHub response"
      }`
    );
  }
}

async function withReviewerCommentDeliveryLock<T>(
  prUrl: string,
  actionToken: string,
  fn: () => Promise<T>
): Promise<T> {
  mkdirSync(REVIEWER_COMMENT_DELIVERY_LOCK_DIR, { recursive: true });
  const target = path.join(
    REVIEWER_COMMENT_DELIVERY_LOCK_DIR,
    createHash("sha256")
      .update(`${prUrl}\0${actionToken}`)
      .digest("hex")
  );
  let compromised: Error | undefined;
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: REVIEWER_COMMENT_DELIVERY_LOCK_STALE_MS,
    update: Math.floor(REVIEWER_COMMENT_DELIVERY_LOCK_STALE_MS / 3),
    retries: {
      retries: 1_200,
      factor: 1,
      minTimeout: 25,
      maxTimeout: 25,
    },
    onCompromised: (error) => {
      compromised = error;
    },
  });
  try {
    const value = await fn();
    if (compromised) throw compromised;
    return value;
  } finally {
    try {
      await release();
    } catch (error) {
      if (!compromised) throw error;
    }
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

  return withReviewerCommentDeliveryLock(
    prUrl,
    delivery.action_token,
    async () => {
      const endpoint =
        `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`;
      const existing = await execPaginatedArrayStrict<IssueCommentItem>(
        endpoint
      );
      if (!existing) {
        throw new Error("Failed to inspect existing PR conversation comments.");
      }
      const recovered = existing
        .filter(
          (comment) =>
            comment.user?.login === authorLogin &&
            comment.body === delivery.body
        )
        .sort((a, b) => a.id - b.id)[0];
      if (recovered) {
        return verifiedReviewerCommentReceipt(
          delivery,
          recovered,
          authorLogin
        );
      }

      const target = await getReviewerCommentDeliveryTarget(pr);
      const observedPRState = target.merged
        ? "merged"
        : (target.state || "unknown").toLowerCase();
      const observedHeadSha = target.head?.sha?.trim();
      if (target.merged || observedPRState !== "open") {
        throw new StaleReviewerCommentDeliveryError(
          "pr_not_open",
          delivery.head_sha,
          observedHeadSha,
          observedPRState
        );
      }
      if (observedHeadSha !== delivery.head_sha) {
        throw new StaleReviewerCommentDeliveryError(
          "head_changed",
          delivery.head_sha,
          observedHeadSha,
          observedPRState
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
  );
}

export const __testUtils = {
  parsePRUrl,
  firstLineOf,
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
