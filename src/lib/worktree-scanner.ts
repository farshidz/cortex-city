import { execFileSync } from "child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "fs";
import path from "path";
import type { Task } from "./types";

const CORTEX_DIR = path.join(process.cwd(), ".cortex");
const TASKS_FILE = path.join(CORTEX_DIR, "tasks.json");
const CONFIG_FILE = path.join(CORTEX_DIR, "config.json");

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

export interface WorktreeCleanupResult extends WorktreeScanResult {
  cleanedWorktrees: OrphanWorktree[];
}

interface WorktreeScannerConfig {
  worktree_roots?: unknown;
  agents?: Record<string, { repo_path?: unknown }>;
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

function isPathWithin(parentPath: string, childPath: string): boolean {
  const parent = normalizeWorktreePath(parentPath);
  const child = normalizeWorktreePath(childPath);
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function getWorktreeRoot(worktreePath: string): string | undefined {
  const resolved = normalizeWorktreePath(worktreePath);
  const parts = resolved.split(path.sep);
  const index = parts.lastIndexOf(".worktrees");
  if (index === -1) return undefined;
  const prefix = parts.slice(0, index + 1).join(path.sep);
  return prefix || path.sep;
}

function addWorktreeRoot(roots: Set<string>, worktreesRoot: string) {
  if (isDirectory(worktreesRoot)) {
    roots.add(normalizeWorktreePath(worktreesRoot));
  }
}

function addManagedWorktreeRoots(roots: Set<string>, errors: string[]) {
  const reposDir = path.join(CORTEX_DIR, "repos");
  if (!existsSync(reposDir)) return;

  try {
    for (const entry of readdirSync(reposDir)) {
      addWorktreeRoot(roots, path.join(reposDir, entry, ".worktrees"));
    }
  } catch (error) {
    errors.push(
      error instanceof Error
        ? `Failed to read managed repos: ${error.message}`
        : "Failed to read managed repos"
    );
  }
}

function readScannerConfig(errors: string[]): WorktreeScannerConfig | undefined {
  if (!existsSync(CONFIG_FILE)) return undefined;

  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch (error) {
    errors.push(
      error instanceof Error
        ? `Failed to read config: ${error.message}`
        : "Failed to read config"
    );
    return undefined;
  }
}

function addConfiguredWorktreeRoots(roots: Set<string>, errors: string[]) {
  const config = readScannerConfig(errors);
  if (!config) return;

  if (Array.isArray(config.worktree_roots)) {
    for (const configuredRoot of config.worktree_roots) {
      if (typeof configuredRoot === "string" && configuredRoot.trim()) {
        addWorktreeRoot(roots, configuredRoot.trim());
      }
    }
  }

  for (const agent of Object.values(config.agents ?? {})) {
    if (!agent || typeof agent !== "object") continue;
    const repoPath = agent.repo_path;
    if (typeof repoPath !== "string" || !repoPath.trim()) continue;
    addWorktreeRoot(roots, path.join(repoPath.trim(), "..", ".worktrees"));
  }
}

function readTaskStore(): { tasks: Task[]; ok: boolean } {
  if (!existsSync(TASKS_FILE)) return { tasks: [], ok: true };
  return { tasks: JSON.parse(readFileSync(TASKS_FILE, "utf-8")), ok: true };
}

function addTaskWorktreeRoots(tasks: Task[], roots: Set<string>) {
  for (const task of tasks) {
    if (!task.worktree_path) continue;
    const root = getWorktreeRoot(task.worktree_path);
    if (
      root &&
      isDirectory(root) &&
      isDirectory(task.worktree_path) &&
      isGitWorktree(task.worktree_path) &&
      isPathWithin(root, task.worktree_path)
    ) {
      roots.add(root);
    }
  }
}

export function scanOrphanWorktrees(): WorktreeScanResult {
  const errors: string[] = [];
  let tasks: Task[] = [];
  let canTrustTaskLinks = true;
  try {
    const result = readTaskStore();
    tasks = result.tasks;
    canTrustTaskLinks = result.ok;
  } catch (error) {
    canTrustTaskLinks = false;
    errors.push(
      error instanceof Error
        ? `Failed to read tasks: ${error.message}`
        : "Failed to read tasks"
    );
  }

  if (!canTrustTaskLinks) {
    return {
      scannedRoots: [],
      linkedWorktreeCount: 0,
      orphanedWorktrees: [],
      errors,
    };
  }

  const linkedWorktrees = new Set(
    tasks
      .map((task) => task.worktree_path)
      .filter((worktreePath): worktreePath is string => Boolean(worktreePath))
      .map(normalizeWorktreePath)
  );
  const roots = new Set<string>();
  addManagedWorktreeRoots(roots, errors);
  addConfiguredWorktreeRoots(roots, errors);
  addTaskWorktreeRoots(tasks, roots);

  const orphanedWorktrees: OrphanWorktree[] = [];
  for (const root of [...roots].sort()) {
    try {
      for (const entry of readdirSync(root)) {
        const worktreePath = normalizeWorktreePath(path.join(root, entry));
        if (!isPathWithin(root, worktreePath)) continue;
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

function getManagedRepoPath(worktree: OrphanWorktree): string | undefined {
  const repoPath = path.resolve(worktree.root, "..", "repo");
  if (isDirectory(repoPath) && existsSync(path.join(repoPath, ".git"))) {
    return repoPath;
  }
  return undefined;
}

function runGitWorktreeRemove(cwd: string, worktreePath: string): boolean {
  try {
    execFileSync("git", ["-C", cwd, "worktree", "remove", "--force", worktreePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function pruneWorktreeMetadata(cwd: string | undefined): void {
  if (!cwd) return;
  try {
    execFileSync("git", ["-C", cwd, "worktree", "prune"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {}
}

function removeOrphanWorktree(worktree: OrphanWorktree): void {
  if (!isPathWithin(worktree.root, worktree.path)) {
    throw new Error(`Refusing to remove worktree outside managed root: ${worktree.path}`);
  }

  const repoPath = getManagedRepoPath(worktree);
  if (
    (repoPath && runGitWorktreeRemove(repoPath, worktree.path)) ||
    runGitWorktreeRemove(worktree.path, worktree.path)
  ) {
    pruneWorktreeMetadata(repoPath);
    return;
  }

  rmSync(worktree.path, { recursive: true, force: true });
  pruneWorktreeMetadata(repoPath);
}

export function cleanupOrphanWorktrees(): WorktreeCleanupResult {
  const initialScan = scanOrphanWorktrees();
  const errors = [...initialScan.errors];
  const cleanedWorktrees: OrphanWorktree[] = [];

  for (const worktree of initialScan.orphanedWorktrees) {
    try {
      removeOrphanWorktree(worktree);
      cleanedWorktrees.push(worktree);
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `Failed to remove orphaned worktree ${worktree.path}: ${error.message}`
          : `Failed to remove orphaned worktree ${worktree.path}`
      );
    }
  }

  const finalScan = scanOrphanWorktrees();
  return {
    ...finalScan,
    errors: [...errors, ...finalScan.errors],
    cleanedWorktrees,
  };
}
