import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import type { Task, OrchestratorConfig } from "./types";

const CORTEX_DIR = path.join(process.cwd(), ".cortex");
const TASKS_FILE = path.join(CORTEX_DIR, "tasks.json");
const CONFIG_FILE = path.join(CORTEX_DIR, "config.json");

function ensureCortexDir() {
  if (!existsSync(CORTEX_DIR)) {
    mkdirSync(CORTEX_DIR, { recursive: true });
  }
}

// Simple promise-chain mutex for serializing writes
let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => T): Promise<T> {
  const result = writeLock.then(fn);
  writeLock = result.then(() => {}, () => {});
  return result;
}

// --- Tasks ---

export function readTasks(): Task[] {
  ensureCortexDir();
  if (!existsSync(TASKS_FILE)) return [];
  const raw = readFileSync(TASKS_FILE, "utf-8");
  return JSON.parse(raw);
}

export function writeTasks(tasks: Task[], commitMsg?: string): Promise<void> {
  return withWriteLock(() => {
    ensureCortexDir();
    writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
    if (commitMsg) autoCommit(commitMsg, TASKS_FILE);
  });
}

export async function getTask(id: string): Promise<Task | undefined> {
  return readTasks().find((t) => t.id === id);
}

export async function createTask(task: Task): Promise<Task> {
  const tasks = readTasks();
  tasks.push(task);
  await writeTasks(tasks, `Add task: ${task.title}`);
  return task;
}

export async function updateTask(
  id: string,
  updates: Partial<Task>,
  commitMsg?: string
): Promise<Task> {
  const tasks = readTasks();
  const index = tasks.findIndex((t) => t.id === id);
  if (index === -1) throw new Error(`Task ${id} not found`);
  tasks[index] = {
    ...tasks[index],
    ...updates,
    updated_at: new Date().toISOString(),
  };
  await writeTasks(tasks, commitMsg);
  return tasks[index];
}

export async function deleteTask(id: string): Promise<void> {
  const tasks = readTasks();
  const task = tasks.find((t) => t.id === id);
  const filtered = tasks.filter((t) => t.id !== id);
  if (filtered.length === tasks.length) throw new Error(`Task ${id} not found`);
  await writeTasks(filtered, `Delete task: ${task?.title || id}`);
}

// --- Config ---

export function readConfig(): OrchestratorConfig {
  ensureCortexDir();
  if (!existsSync(CONFIG_FILE)) {
    const defaults = getDefaultConfig();
    writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  const raw = readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(raw);
}

export function writeConfig(
  config: OrchestratorConfig,
  commitMsg?: string
): Promise<void> {
  return withWriteLock(() => {
    ensureCortexDir();
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    if (commitMsg) autoCommit(commitMsg, CONFIG_FILE);
  });
}

// --- Auto-commit ---

const ROOT = process.cwd();

export function autoCommit(message: string, ...files: string[]) {
  try {
    const relative = files.map((f) =>
      path.isAbsolute(f) ? path.relative(ROOT, f) : f
    );
    execSync(`git add ${relative.map((f) => `"${f}"`).join(" ")}`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    execSync(`git diff --cached --quiet`, { cwd: ROOT, stdio: "pipe" });
    // If we get here, there's nothing staged — skip commit
  } catch {
    // diff --cached --quiet exits non-zero when there ARE staged changes
    try {
      execSync(`git commit -m "${message}"`, { cwd: ROOT, stdio: "pipe" });
    } catch (err) {
      console.error("[autocommit] commit failed:", err);
    }
  }
}

function getDefaultConfig(): OrchestratorConfig {
  return {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    permission_mode: "bypassPermissions",
    agents: {},
  };
}
