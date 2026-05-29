import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import type { Issue, IssueComment, IssuePriority, IssueStatus, Task } from "./types";
import { snapshotCortex } from "./cortex-git";
import { ensureCortexDir } from "./store";

const ISSUES_FILE = path.join(process.cwd(), ".cortex", "issues.json");

let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = writeLock.then(fn);
  writeLock = result.then(() => {}, () => {});
  return result;
}

export function readIssues(): Issue[] {
  ensureCortexDir();
  if (!existsSync(ISSUES_FILE)) return [];
  try {
    const raw = readFileSync(ISSUES_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeIssue);
  } catch {
    return [];
  }
}

const VALID_PRIORITIES: IssuePriority[] = ["low", "medium", "high"];

function normalizePriority(value: unknown): IssuePriority | undefined {
  if (typeof value !== "string") return undefined;
  return VALID_PRIORITIES.includes(value as IssuePriority)
    ? (value as IssuePriority)
    : undefined;
}

function normalizeIssue(issue: Partial<Issue>): Issue {
  return {
    id: issue.id ?? nanoid(10),
    title: issue.title ?? "",
    description: issue.description ?? "",
    plan: issue.plan,
    status: (issue.status as IssueStatus) ?? "open",
    priority: normalizePriority(issue.priority),
    task_id: issue.task_id,
    comments: Array.isArray(issue.comments) ? issue.comments : [],
    created_at: issue.created_at ?? new Date().toISOString(),
    updated_at: issue.updated_at ?? issue.created_at ?? new Date().toISOString(),
  };
}

function writeIssuesLocked(issues: Issue[]): void {
  ensureCortexDir();
  writeFileSync(ISSUES_FILE, JSON.stringify(issues, null, 2));
  snapshotCortex("issues");
}

export async function getIssue(id: string): Promise<Issue | undefined> {
  return readIssues().find((i) => i.id === id);
}

export interface CreateIssueInput {
  title: string;
  description: string;
  plan?: string;
  priority?: IssuePriority;
}

export async function createIssue(input: CreateIssueInput): Promise<Issue> {
  return withWriteLock(() => {
    const now = new Date().toISOString();
    const issue: Issue = {
      id: nanoid(10),
      title: input.title,
      description: input.description,
      plan: input.plan || undefined,
      status: "open",
      priority: normalizePriority(input.priority),
      comments: [],
      created_at: now,
      updated_at: now,
    };
    const issues = readIssues();
    issues.push(issue);
    writeIssuesLocked(issues);
    return issue;
  });
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  plan?: string;
  status?: IssueStatus;
  priority?: IssuePriority | null;
}

export async function updateIssue(
  id: string,
  updates: UpdateIssueInput
): Promise<Issue> {
  return withWriteLock(() => {
    const issues = readIssues();
    const index = issues.findIndex((i) => i.id === id);
    if (index === -1) throw new Error(`Issue ${id} not found`);
    const { priority: priorityUpdate, ...rest } = updates;
    const next: Issue = {
      ...issues[index],
      ...rest,
      updated_at: new Date().toISOString(),
    };
    if (priorityUpdate === null) {
      next.priority = undefined;
    } else if (priorityUpdate !== undefined) {
      next.priority = normalizePriority(priorityUpdate);
    }
    issues[index] = next;
    writeIssuesLocked(issues);
    return issues[index];
  });
}

export async function deleteIssue(id: string): Promise<void> {
  return withWriteLock(() => {
    const issues = readIssues();
    const filtered = issues.filter((i) => i.id !== id);
    if (filtered.length === issues.length) throw new Error(`Issue ${id} not found`);
    writeIssuesLocked(filtered);
  });
}

export async function addComment(id: string, body: string): Promise<IssueComment> {
  return withWriteLock(() => {
    const issues = readIssues();
    const index = issues.findIndex((i) => i.id === id);
    if (index === -1) throw new Error(`Issue ${id} not found`);
    const comment: IssueComment = {
      id: nanoid(8),
      body,
      created_at: new Date().toISOString(),
    };
    issues[index] = {
      ...issues[index],
      comments: [...issues[index].comments, comment],
      updated_at: comment.created_at,
    };
    writeIssuesLocked(issues);
    return comment;
  });
}

export async function linkTask(issueId: string, taskId: string): Promise<Issue> {
  return withWriteLock(() => {
    const issues = readIssues();
    const index = issues.findIndex((i) => i.id === issueId);
    if (index === -1) throw new Error(`Issue ${issueId} not found`);
    const current = issues[index];
    if (current.task_id && current.task_id !== taskId) {
      throw new Error(`Issue ${issueId} is already linked to task ${current.task_id}`);
    }
    issues[index] = {
      ...current,
      task_id: taskId,
      // A linked task always implies in_progress (task starts open → maps to in_progress).
      status: "in_progress",
      updated_at: new Date().toISOString(),
    };
    writeIssuesLocked(issues);
    return issues[index];
  });
}

export interface UnlinkOptions {
  keepTerminalStatus: boolean;
}

export async function unlinkTask(
  issueId: string,
  opts: UnlinkOptions
): Promise<Issue | undefined> {
  return withWriteLock(() => {
    const issues = readIssues();
    const index = issues.findIndex((i) => i.id === issueId);
    if (index === -1) return undefined;
    const current = issues[index];
    if (!current.task_id) return current;
    const isTerminal = current.status === "done" || current.status === "closed";
    const nextStatus: IssueStatus =
      opts.keepTerminalStatus && isTerminal ? current.status : "open";
    issues[index] = {
      ...current,
      task_id: undefined,
      status: nextStatus,
      updated_at: new Date().toISOString(),
    };
    writeIssuesLocked(issues);
    return issues[index];
  });
}

// Map task lifecycle → issue lifecycle. Task is authoritative whenever linked.
export async function syncIssueFromTask(task: Task): Promise<void> {
  if (!task.issue_id) return;
  await withWriteLock(() => {
    const issues = readIssues();
    const index = issues.findIndex((i) => i.id === task.issue_id);
    if (index === -1) return;
    const current = issues[index];
    if (current.task_id && current.task_id !== task.id) return;
    const nextStatus = mapTaskStatusToIssueStatus(task.status);
    if (current.status === nextStatus && current.task_id === task.id) return;
    issues[index] = {
      ...current,
      task_id: task.id,
      status: nextStatus,
      updated_at: new Date().toISOString(),
    };
    writeIssuesLocked(issues);
  });
}

const PRIORITY_RANK: Record<IssuePriority, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export function compareIssues(a: Issue, b: Issue): number {
  const aRank = a.priority ? PRIORITY_RANK[a.priority] : 0;
  const bRank = b.priority ? PRIORITY_RANK[b.priority] : 0;
  if (aRank !== bRank) return bRank - aRank;
  return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
}

export function mapTaskStatusToIssueStatus(status: Task["status"]): IssueStatus {
  switch (status) {
    case "merged":
      return "done";
    case "closed":
      return "closed";
    default:
      return "in_progress";
  }
}
