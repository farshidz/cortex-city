import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "fs";
import path from "path";
import type { Task } from "./types";

const CORTEX_DIR = path.join(process.cwd(), ".cortex");
const TASKS_FILE = path.join(CORTEX_DIR, "tasks.json");

export interface OrphanWorktree {
  path: string;
  root: string;
}

export interface WorktreeScanResult {
  scannedRoots: string[];
  linkedWorktreeCount: number;
  orphanedWorktrees: OrphanWorktree[];
  errors: string[];
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isGitWorktree(target: string): boolean {
  return existsSync(path.join(target, ".git"));
}

function normalizeWorktreePath(worktreePath: string): string {
  const resolved = path.resolve(worktreePath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function getWorktreeRoot(worktreePath: string): string | undefined {
  const resolved = normalizeWorktreePath(worktreePath);
  const parts = resolved.split(path.sep);
  const index = parts.lastIndexOf(".worktrees");
  if (index === -1) return undefined;
  const prefix = parts.slice(0, index + 1).join(path.sep);
  return prefix || path.sep;
}

function addManagedWorktreeRoots(roots: Set<string>, errors: string[]) {
  const reposDir = path.join(CORTEX_DIR, "repos");
  if (!existsSync(reposDir)) return;

  try {
    for (const entry of readdirSync(reposDir)) {
      const worktreesRoot = path.join(reposDir, entry, ".worktrees");
      if (isDirectory(worktreesRoot)) {
        roots.add(normalizeWorktreePath(worktreesRoot));
      }
    }
  } catch (error) {
    errors.push(
      error instanceof Error
        ? `Failed to read managed repos: ${error.message}`
        : "Failed to read managed repos"
    );
  }
}

function readTaskStore(): Task[] {
  if (!existsSync(TASKS_FILE)) return [];
  return JSON.parse(readFileSync(TASKS_FILE, "utf-8"));
}

function addTaskWorktreeRoots(tasks: Task[], roots: Set<string>) {
  for (const task of tasks) {
    if (!task.worktree_path) continue;
    const root = getWorktreeRoot(task.worktree_path);
    if (root && isDirectory(root)) {
      roots.add(root);
    }
  }
}

export function scanOrphanWorktrees(): WorktreeScanResult {
  const errors: string[] = [];
  let tasks: Task[] = [];
  try {
    tasks = readTaskStore();
  } catch (error) {
    errors.push(
      error instanceof Error
        ? `Failed to read tasks: ${error.message}`
        : "Failed to read tasks"
    );
  }

  const linkedWorktrees = new Set(
    tasks
      .map((task) => task.worktree_path)
      .filter((worktreePath): worktreePath is string => Boolean(worktreePath))
      .map(normalizeWorktreePath)
  );
  const roots = new Set<string>();
  addManagedWorktreeRoots(roots, errors);
  addTaskWorktreeRoots(tasks, roots);

  const orphanedWorktrees: OrphanWorktree[] = [];
  for (const root of [...roots].sort()) {
    try {
      for (const entry of readdirSync(root)) {
        const worktreePath = normalizeWorktreePath(path.join(root, entry));
        if (!isDirectory(worktreePath) || !isGitWorktree(worktreePath)) continue;
        if (!linkedWorktrees.has(worktreePath)) {
          orphanedWorktrees.push({ path: worktreePath, root });
        }
      }
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `Failed to scan ${root}: ${error.message}`
          : `Failed to scan ${root}`
      );
    }
  }

  return {
    scannedRoots: [...roots].sort(),
    linkedWorktreeCount: linkedWorktrees.size,
    orphanedWorktrees,
    errors,
  };
}
