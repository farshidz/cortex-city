import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import path from "path";
import type { Task, OrchestratorConfig } from "./types";
import { snapshotCortex } from "./cortex-git";
import { deleteTaskLogs } from "./logger";
import { DEFAULT_TASK_RUN_TIMEOUT_MS } from "./run-timeout";
import { syncIssueFromTask } from "./issue-store";
import { assertSufficientDiskSpace } from "./disk-guard";

const CORTEX_DIR = path.join(process.cwd(), ".cortex");
const TASKS_FILE = path.join(CORTEX_DIR, "tasks.json");
const CONFIG_FILE = path.join(CORTEX_DIR, "config.json");
const GITIGNORE_FILE = path.join(CORTEX_DIR, ".gitignore");
const BACKUPS_DIR = path.join(CORTEX_DIR, "backups");
const DEFAULT_CORTEX_GITIGNORE_ENTRIES = [
  "orchestrator-state.json",
  ".env.*",
  ".env",
  "repos/",
  "backups/",
];
const DEFAULT_CORTEX_GITIGNORE = `${DEFAULT_CORTEX_GITIGNORE_ENTRIES.join("\n")}\n`;
type StoredConfig = Partial<OrchestratorConfig> & {
  agent_runner?: OrchestratorConfig["default_agent_runner"];
  permission_mode?: OrchestratorConfig["default_permission_mode"];
};

export function ensureCortexDir() {
  if (!existsSync(CORTEX_DIR)) {
    mkdirSync(CORTEX_DIR, { recursive: true });
  }
  if (!existsSync(GITIGNORE_FILE)) {
    writeFileSync(GITIGNORE_FILE, DEFAULT_CORTEX_GITIGNORE);
    return;
  }

  const existing = readFileSync(GITIGNORE_FILE, "utf-8");
  const lines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const missing = DEFAULT_CORTEX_GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return;

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(GITIGNORE_FILE, `${existing}${prefix}${missing.join("\n")}\n`);
}

export function getCortexPath(...segments: string[]): string {
  ensureCortexDir();
  return path.join(CORTEX_DIR, ...segments);
}

function backupPathFor(filePath: string): string {
  return path.join(BACKUPS_DIR, `${path.basename(filePath)}.last-good`);
}

function writeTextFileAtomic(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, "w", 0o600);
    writeSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, filePath);

    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw error;
  }
}

function writeJsonFileAtomic(filePath: string, value: unknown, label: string): void {
  ensureCortexDir();
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(contents);
  assertSufficientDiskSpace(`writing ${label}`, CORTEX_DIR);
  writeTextFileAtomic(filePath, contents);

  try {
    writeTextFileAtomic(backupPathFor(filePath), contents);
  } catch (error) {
    console.warn(
      `[store] Failed to update last-good backup for ${label}:`,
      error instanceof Error ? error.message : error
    );
  }
}

function readJsonFileWithBackup<T>(filePath: string, label: string): T {
  const raw = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const backupPath = backupPathFor(filePath);
    if (!existsSync(backupPath)) throw error;

    const backupRaw = readFileSync(backupPath, "utf-8");
    const parsed = JSON.parse(backupRaw) as T;
    console.error(
      `[store] Failed to parse ${label}; using last-good backup at ${backupPath}:`,
      error instanceof Error ? error.message : error
    );

    try {
      assertSufficientDiskSpace(`restoring ${label} from backup`, CORTEX_DIR);
      writeTextFileAtomic(filePath, backupRaw);
    } catch (restoreError) {
      console.error(
        `[store] Failed to restore ${label} from last-good backup:`,
        restoreError instanceof Error ? restoreError.message : restoreError
      );
    }

    return parsed;
  }
}

// Simple promise-chain mutex for serializing writes
let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = writeLock.then(fn);
  writeLock = result.then(() => {}, () => {});
  return result;
}

// --- Tasks ---

const LEGACY_REVIEWER_TASK_FIELDS = [
  "reviewer_session_id",
  "reviewer_run_pending",
  "reviewer_last_reviewed_head_sha",
  "reviewer_codex_usage_session_id",
  "reviewer_codex_cumulative_input_tokens",
  "reviewer_codex_cumulative_cached_input_tokens",
  "reviewer_codex_cumulative_output_tokens",
] as const;

function normalizeTask(task: Task): Task {
  const normalized = { ...task } as Task & Record<string, unknown>;
  const legacy = normalized as Record<string, unknown>;
  const legacyReviewedHead = legacy.reviewer_last_reviewed_head_sha;
  if (
    !normalized.review_migration_head_sha &&
    typeof legacyReviewedHead === "string" &&
    legacyReviewedHead.trim()
  ) {
    normalized.review_migration_head_sha = legacyReviewedHead.trim();
  }
  for (const field of LEGACY_REVIEWER_TASK_FIELDS) {
    delete legacy[field];
  }

  // A live reviewer process from the previous release remains visible so the
  // worker can stop it before launching the unified reviewer. Dead or merely
  // queued legacy reviewer state is cleared immediately so it cannot turn into
  // an implementation-agent run.
  if (legacy.resume_run_mode === "reviewer") {
    delete legacy.resume_run_mode;
    delete legacy.resume_requested;
  }
  if (
    legacy.current_run_mode === "reviewer" &&
    typeof legacy.current_run_pid !== "number"
  ) {
    delete legacy.current_run_mode;
  }

  return normalized as Task;
}

export function readTasks(): Task[] {
  ensureCortexDir();
  if (!existsSync(TASKS_FILE)) return [];
  return readJsonFileWithBackup<Task[]>(TASKS_FILE, "tasks.json").map(
    normalizeTask
  );
}

function writeTasksLocked(tasks: Task[]): void {
  writeJsonFileAtomic(TASKS_FILE, tasks.map(normalizeTask), "tasks.json");
  snapshotCortex("tasks");
}

export function writeTasks(tasks: Task[]): Promise<void> {
  return withWriteLock(() => {
    writeTasksLocked(tasks);
  });
}

export async function getTask(id: string): Promise<Task | undefined> {
  return readTasks().find((t) => t.id === id);
}

export async function createTask(task: Task): Promise<Task> {
  return withWriteLock(() => {
    const tasks = readTasks();
    tasks.push(task);
    writeTasksLocked(tasks);
    return task;
  });
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task> {
  return withWriteLock(async () => {
    const tasks = readTasks();
    const index = tasks.findIndex((t) => t.id === id);
    if (index === -1) throw new Error(`Task ${id} not found`);
    tasks[index] = {
      ...tasks[index],
      ...updates,
      updated_at: new Date().toISOString(),
    };
    writeTasksLocked(tasks);
    const updated = tasks[index];
    if (updated.issue_id) {
      await syncIssueFromTask(updated);
    }
    return updated;
  });
}

export async function deleteTask(id: string): Promise<void> {
  return withWriteLock(() => {
    const tasks = readTasks();
    const filtered = tasks.filter((t) => t.id !== id);
    if (filtered.length === tasks.length) throw new Error(`Task ${id} not found`);
    writeTasksLocked(filtered);
    deleteTaskLogs(id);
  });
}

// --- Config ---

export function readConfig(): OrchestratorConfig {
  ensureCortexDir();
  const defaults = getDefaultConfig();
  if (!existsSync(CONFIG_FILE)) {
    writeJsonFileAtomic(CONFIG_FILE, defaults, "config.json");
    return defaults;
  }
  const parsed = readJsonFileWithBackup<StoredConfig>(
    CONFIG_FILE,
    "config.json"
  );
  const { agent_runner: legacyRunner, ...rest } = parsed;
  return {
    ...defaults,
    ...rest,
    review_learning_enabled: rest.review_learning_enabled ?? true,
    default_agent_runner:
      rest.default_agent_runner || legacyRunner || defaults.default_agent_runner,
    default_permission_mode:
      rest.default_permission_mode || rest.permission_mode || defaults.default_permission_mode,
    agents: rest.agents ?? {},
  };
}

export function writeConfig(config: OrchestratorConfig): Promise<void> {
  return withWriteLock(() => {
    writeJsonFileAtomic(CONFIG_FILE, config, "config.json");
    snapshotCortex("config");
  });
}

function getDefaultConfig(): OrchestratorConfig {
  return {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    task_run_timeout_ms: DEFAULT_TASK_RUN_TIMEOUT_MS,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    review_learning_enabled: true,
    agents: {},
  };
}
