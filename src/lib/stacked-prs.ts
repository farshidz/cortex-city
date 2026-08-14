import type {
  AgentReportStackedPR,
  PRStatus,
  Task,
  TaskStackedPR,
  TaskStatus,
} from "./types";

// Worst-first ordering used to aggregate a stack's open entries into the
// single task-level pr_status shown in list UIs.
const PR_STATUS_SEVERITY: PRStatus[] = [
  "conflicts",
  "checks_failing",
  "unstable",
  "checks_pending",
  "needs_approval",
  "clean",
];

export function isStackedTask(
  task: Pick<Task, "stacked_prs">
): task is Pick<Task, "stacked_prs"> & { stacked_prs: TaskStackedPR[] } {
  return Array.isArray(task.stacked_prs) && task.stacked_prs.length > 0;
}

function sortedByPosition(stack: TaskStackedPR[]): TaskStackedPR[] {
  return [...stack].sort((a, b) => a.position - b.position);
}

export function openStackedPRs(stack: TaskStackedPR[]): TaskStackedPR[] {
  return sortedByPosition(stack).filter((entry) => entry.state === "open");
}

// The bottom-most open PR: the entry closest to merging into the base branch.
// Task.pr_url/branch_name mirror this entry for single-PR consumers.
export function frontierStackedPR(
  stack: TaskStackedPR[]
): TaskStackedPR | undefined {
  return openStackedPRs(stack)[0];
}

export function aggregateStackPRStatus(
  stack: TaskStackedPR[]
): PRStatus | undefined {
  const statuses = new Set(
    openStackedPRs(stack)
      .map((entry) => entry.pr_status)
      .filter((status): status is PRStatus => Boolean(status))
  );
  return PR_STATUS_SEVERITY.find((status) => statuses.has(status));
}

// A stack needs restacking when an open entry still bases on the branch of a
// MERGED PR, or still carries an unverified restack obligation
// (pending_restack_of): squash merges rewrite the merged commits, so the open
// entry must be retargeted and rebased — and GitHub must confirm the merged
// commit is an ancestor of the entry's head — before the obligation clears.
// Rebasing an entry rewrites its own branch too, which invalidates the merge
// base of every open entry above it — so the restack set is the whole open
// suffix starting at the first affected entry, not just the entries directly
// on merged bases.
export function stackEntriesRequiringRestack(
  stack: TaskStackedPR[]
): TaskStackedPR[] {
  const mergedBranches = new Set(
    stack
      .filter((entry) => entry.state === "merged")
      .map((entry) => entry.branch_name)
  );
  const open = openStackedPRs(stack);
  const firstAffected = open.findIndex(
    (entry) =>
      mergedBranches.has(entry.base_branch) ||
      (entry.pending_restack_of?.length ?? 0) > 0
  );
  if (firstAffected === -1) return [];
  return open.slice(firstAffected);
}

export function stackRequiresRestack(stack: TaskStackedPR[]): boolean {
  return stackEntriesRequiringRestack(stack).length > 0;
}

// A closed, unmerged base is a broken stack, not a restack: the closed PR's
// commits are NOT in the base branch, so the squash-merge restack protocol
// (dropping the lower commits) would silently delete that slice's work.
// These entries need a human decision (reopen, re-plan, or abandon).
export function stackEntriesOnClosedBase(
  stack: TaskStackedPR[]
): TaskStackedPR[] {
  const closedBranches = new Set(
    stack
      .filter((entry) => entry.state === "closed")
      .map((entry) => entry.branch_name)
  );
  return openStackedPRs(stack).filter((entry) =>
    closedBranches.has(entry.base_branch)
  );
}

// Stable identity of the current broken-stack (closed unmerged base)
// condition. A decision-run acknowledgement is scoped to this exact value so
// an unrelated blocked report — or an acknowledgement of an earlier, different
// closure — can never suppress surfacing the current one.
export function stackClosedBaseFingerprint(
  stack: TaskStackedPR[]
): string | undefined {
  const affected = stackEntriesOnClosedBase(stack)
    .map((entry) => `${entry.pr_url}<-${entry.base_branch}`)
    .sort();
  if (affected.length === 0) return undefined;
  return `closed_base:${affected.join("|")}`;
}

// Terminal task status once every entry is terminal: merged only when the
// whole stack merged; any entry closed without merging needs human attention.
export function stackTerminalStatus(
  stack: TaskStackedPR[]
): Extract<TaskStatus, "merged" | "closed"> | undefined {
  if (stack.length === 0 || stack.some((entry) => entry.state === "open")) {
    return undefined;
  }
  return stack.every((entry) => entry.state === "merged") ? "merged" : "closed";
}

const CANONICAL_PR_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

export function githubPullRequestIdentity(prUrl: string): string | undefined {
  const match = prUrl
    .trim()
    .match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/i);
  if (!match) return undefined;
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${Number(match[3])}`;
}

function normalizeReportedEntry(
  entry: AgentReportStackedPR
): AgentReportStackedPR | string {
  const pr_url = entry.pr_url?.trim();
  const branch_name = entry.branch_name?.trim();
  const base_branch = entry.base_branch?.trim();
  if (!pr_url || !branch_name || !base_branch) {
    return `stack entry ${JSON.stringify(entry.pr_url ?? "")} is missing a PR URL, branch, or base branch`;
  }
  if (!CANONICAL_PR_URL_PATTERN.test(pr_url)) {
    return `stack entry PR URL ${JSON.stringify(pr_url)} is not a canonical GitHub pull request URL`;
  }
  if (!Number.isInteger(entry.position) || entry.position < 1) {
    return `stack entry ${pr_url} has invalid position ${JSON.stringify(entry.position)}`;
  }
  return {
    position: entry.position,
    pr_url,
    branch_name,
    base_branch,
    scope: entry.scope?.trim() || "",
  };
}

// The report replaces stack membership, so it must be valid as a whole: a
// partially-accepted stack silently shrinks the task (an omitted real PR is
// never reviewed, restacked, or waited on before the task completes).
function validateReportedStack(
  reported: AgentReportStackedPR[]
): { entries: AgentReportStackedPR[] } | { error: string } {
  const entries: AgentReportStackedPR[] = [];
  const seenIdentities = new Set<string>();
  const seenPositions = new Set<number>();
  for (const raw of reported) {
    const normalized = normalizeReportedEntry(raw);
    if (typeof normalized === "string") return { error: normalized };
    const identity = githubPullRequestIdentity(normalized.pr_url);
    if (!identity) {
      return {
        error: `stack entry PR URL ${JSON.stringify(normalized.pr_url)} is not a canonical GitHub pull request URL`,
      };
    }
    if (seenIdentities.has(identity)) {
      return { error: `stack entry ${normalized.pr_url} is listed twice` };
    }
    if (seenPositions.has(normalized.position)) {
      return {
        error: `stack position ${normalized.position} is listed twice`,
      };
    }
    seenIdentities.add(identity);
    seenPositions.add(normalized.position);
    entries.push(normalized);
  }
  for (let position = 1; position <= entries.length; position++) {
    if (!seenPositions.has(position)) {
      return {
        error: `stack positions are not contiguous from 1 (missing position ${position})`,
      };
    }
  }
  return { entries };
}

export interface StackReconciliation {
  stack: TaskStackedPR[];
  warnings: string[];
}

// Merge the stack the agent reported into the stack the task already tracks.
// The report is authoritative for membership and shape (branches, bases,
// scopes, ordering); the worker-owned lifecycle fields on existing entries
// (state, pr_status, last_review_gh_state) are preserved. Entries the report
// omits are kept — the worker retires entries via GitHub state, not report
// omissions — with a warning so prompt drift stays visible in logs. A report
// that fails validation is rejected atomically: the tracked stack is kept
// unchanged rather than accepting a partial membership list.
export function reconcileStackedPRs(
  current: TaskStackedPR[] | undefined,
  reported: AgentReportStackedPR[] | null | undefined
): StackReconciliation | undefined {
  const existing = current ?? [];

  if (!reported || reported.length === 0) {
    if (existing.length === 0) return undefined;
    return {
      stack: sortedByPosition(existing).map((entry) => ({ ...entry })),
      warnings: [
        "Agent report omitted stacked_prs for a stacked task; keeping the tracked stack unchanged",
      ],
    };
  }

  const validated = validateReportedStack(reported);
  if ("error" in validated) {
    if (existing.length === 0) {
      return {
        stack: [],
        warnings: [
          `Rejected stacked_prs report (${validated.error}); the task keeps tracking a single PR`,
        ],
      };
    }
    return {
      stack: sortedByPosition(existing).map((entry) => ({ ...entry })),
      warnings: [
        `Rejected stacked_prs report (${validated.error}); keeping the tracked stack unchanged`,
      ],
    };
  }

  const warnings: string[] = [];
  const existingByIdentity = new Map(
    existing.map(
      (entry) => [
        githubPullRequestIdentity(entry.pr_url) ?? entry.pr_url,
        entry,
      ] as const
    )
  );
  const reportedIdentities = new Set<string>();
  const merged: TaskStackedPR[] = [];

  for (const entry of validated.entries) {
    const identity = githubPullRequestIdentity(entry.pr_url) ?? entry.pr_url;
    reportedIdentities.add(identity);
    const tracked = existingByIdentity.get(identity);
    merged.push({
      ...entry,
      scope: entry.scope || tracked?.scope || "",
      state: tracked?.state ?? "open",
      pr_status: tracked?.pr_status,
      last_review_gh_state: tracked?.last_review_gh_state,
      merge_commit_sha: tracked?.merge_commit_sha,
      pending_restack_of: tracked?.pending_restack_of,
    });
  }

  for (const entry of existing) {
    const identity = githubPullRequestIdentity(entry.pr_url) ?? entry.pr_url;
    if (reportedIdentities.has(identity)) continue;
    warnings.push(
      `Agent report dropped stack entry ${entry.pr_url}; keeping it until GitHub reports it merged or closed`
    );
    merged.push({ ...entry });
  }

  return { stack: sortedByPosition(merged), warnings };
}
