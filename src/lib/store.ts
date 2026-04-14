import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
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

export function writeTasks(tasks: Task[]): Promise<void> {
  return withWriteLock(() => {
    ensureCortexDir();
    writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  });
}

export async function getTask(id: string): Promise<Task | undefined> {
  return readTasks().find((t) => t.id === id);
}

export async function createTask(task: Task): Promise<Task> {
  const tasks = readTasks();
  tasks.push(task);
  await writeTasks(tasks);
  return task;
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task> {
  const tasks = readTasks();
  const index = tasks.findIndex((t) => t.id === id);
  if (index === -1) throw new Error(`Task ${id} not found`);
  tasks[index] = {
    ...tasks[index],
    ...updates,
    updated_at: new Date().toISOString(),
  };
  await writeTasks(tasks);
  return tasks[index];
}

export async function deleteTask(id: string): Promise<void> {
  const tasks = readTasks();
  const filtered = tasks.filter((t) => t.id !== id);
  if (filtered.length === tasks.length) throw new Error(`Task ${id} not found`);
  await writeTasks(filtered);
}

// --- Config ---

export function readConfig(): OrchestratorConfig {
  ensureCortexDir();
  const defaults = getDefaultConfig();
  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  const raw = readFileSync(CONFIG_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  return {
    ...defaults,
    ...parsed,
    agents: parsed.agents ?? {},
  };
}

export function writeConfig(config: OrchestratorConfig): Promise<void> {
  return withWriteLock(() => {
    ensureCortexDir();
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  });
}

function getDefaultConfig(): OrchestratorConfig {
  return {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    permission_mode: "bypassPermissions",
    agent_runner: "claude",
    agents: {},
  };
}
