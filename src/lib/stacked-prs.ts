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

// A stack needs restacking when an open entry still bases on a branch whose
// PR already reached a terminal state. Squash merges rewrite the merged
// commits, so the open entry must be retargeted and rebased before it can
// merge cleanly.
export function stackEntriesRequiringRestack(
  stack: TaskStackedPR[]
): TaskStackedPR[] {
  const terminalBranches = new Set(
    stack
      .filter((entry) => entry.state !== "open")
      .map((entry) => entry.branch_name)
  );
  return openStackedPRs(stack).filter((entry) =>
    terminalBranches.has(entry.base_branch)
  );
}

export function stackRequiresRestack(stack: TaskStackedPR[]): boolean {
  return stackEntriesRequiringRestack(stack).length > 0;
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

function normalizeReportedEntry(
  entry: AgentReportStackedPR
): AgentReportStackedPR | undefined {
  const pr_url = entry.pr_url?.trim();
  const branch_name = entry.branch_name?.trim();
  const base_branch = entry.base_branch?.trim();
  if (!pr_url || !branch_name || !base_branch) return undefined;
  return {
    position: entry.position,
    pr_url,
    branch_name,
    base_branch,
    scope: entry.scope?.trim() || "",
  };
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
// omissions — with a warning so prompt drift stays visible in logs.
export function reconcileStackedPRs(
  current: TaskStackedPR[] | undefined,
  reported: AgentReportStackedPR[] | null | undefined
): StackReconciliation | undefined {
  const existing = current ?? [];
  const validReported = (reported ?? [])
    .map(normalizeReportedEntry)
    .filter((entry): entry is AgentReportStackedPR => Boolean(entry));

  if (validReported.length === 0) {
    if (existing.length === 0) return undefined;
    return {
      stack: sortedByPosition(existing),
      warnings: [
        "Agent report omitted stacked_prs for a stacked task; keeping the tracked stack unchanged",
      ],
    };
  }

  const warnings: string[] = [];
  const existingByUrl = new Map(
    existing.map((entry) => [entry.pr_url, entry] as const)
  );
  const reportedUrls = new Set<string>();
  const merged: TaskStackedPR[] = [];

  for (const entry of validReported) {
    if (reportedUrls.has(entry.pr_url)) {
      warnings.push(`Agent report listed ${entry.pr_url} twice; keeping the first entry`);
      continue;
    }
    reportedUrls.add(entry.pr_url);
    const tracked = existingByUrl.get(entry.pr_url);
    merged.push({
      ...entry,
      scope: entry.scope || tracked?.scope || "",
      state: tracked?.state ?? "open",
      pr_status: tracked?.pr_status,
      last_review_gh_state: tracked?.last_review_gh_state,
    });
  }

  for (const entry of existing) {
    if (reportedUrls.has(entry.pr_url)) continue;
    warnings.push(
      `Agent report dropped stack entry ${entry.pr_url}; keeping it until GitHub reports it merged or closed`
    );
    merged.push({ ...entry });
  }

  return { stack: sortedByPosition(merged), warnings };
}
