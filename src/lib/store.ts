import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import path from "path";
import type { Task, OrchestratorConfig } from "./types";
import { snapshotCortex } from "./cortex-git";
import { deleteTaskLogs } from "./logger";
import { DEFAULT_TASK_RUN_TIMEOUT_MS } from "./run-timeout";
import { syncIssueFromTask } from "./issue-store";
import { assertSufficientDiskSpace } from "./disk-guard";

const CORTEX_DIR = path.join(process.cwd(), ".cortex");
const TASKS_FILE = path.join(CORTEX_DIR, "tasks.json");
const TASKS_WRITE_LOCK_PREFIX = ".tasks.write.lock";
const CONFIG_FILE = path.join(CORTEX_DIR, "config.json");
const GITIGNORE_FILE = path.join(CORTEX_DIR, ".gitignore");
const BACKUPS_DIR = path.join(CORTEX_DIR, "backups");
const DEFAULT_CORTEX_GITIGNORE_ENTRIES = [
  ".tasks.write.lock.*",
  "orchestrator-state.json",
  ".env.*",
  ".env",
  "repos/",
  "backups/",
];
const DEFAULT_CORTEX_GITIGNORE = `${DEFAULT_CORTEX_GITIGNORE_ENTRIES.join("\n")}\n`;
const TASKS_WRITE_LOCK_RETRY_MS = 10;
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

export function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  label: string
): void {
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

export function readJsonFileWithBackup<T>(
  filePath: string,
  label: string,
  validate?: (value: unknown) => value is T
): T {
  const parse = (raw: string): T => {
    const parsed = JSON.parse(raw) as unknown;
    if (validate && !validate(parsed)) {
      throw new Error(`${label} has an invalid top-level structure.`);
    }
    return parsed as T;
  };
  let primaryError: unknown;
  try {
    return parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    primaryError = error;
  }

  const backupPath = backupPathFor(filePath);
  if (!existsSync(backupPath)) throw primaryError;

  const backupRaw = readFileSync(backupPath, "utf-8");
  const parsed = parse(backupRaw);
  console.error(
    `[store] Failed to read ${label}; using last-good backup at ${backupPath}:`,
    primaryError instanceof Error ? primaryError.message : primaryError
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

// Simple promise-chain mutex for serializing writes
let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = writeLock.then(fn);
  writeLock = result.then(() => {}, () => {});
  return result;
}

interface TasksWriteLockRecordBase {
  pid: number;
  processInstance: string;
  token: string;
  path: string;
}

type TasksWriteLockRecord =
  | (TasksWriteLockRecordBase & { kind: "choosing" })
  | (TasksWriteLockRecordBase & { kind: "ticket"; ticket: number });

function isErrnoException(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrnoException(error, "ESRCH");
  }
}

function getProcessInstance(pid: number): string | undefined {
  let startedAt: string | undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (/^\d+$/.test(fields[19] || "")) {
        startedAt = `linux:${fields[19]}`;
      }
    } catch {}
  }

  if (!startedAt) {
    try {
      const value = execFileSync(
        process.platform === "darwin" ? "/bin/ps" : "ps",
        ["-o", "lstart=", "-p", String(pid)],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (value) startedAt = `ps:${value}`;
    } catch {}
  }

  return startedAt
    ? createHash("sha256").update(startedAt).digest("hex")
    : undefined;
}

let currentProcessInstance: string | undefined;

function readProcessInstance(pid: number): string | undefined {
  if (pid !== process.pid) return getProcessInstance(pid);
  currentProcessInstance ??= getProcessInstance(pid);
  return currentProcessInstance;
}

function parseTasksWriteLockRecord(name: string): TasksWriteLockRecord | undefined {
  const choosing = name.match(
    /^\.tasks\.write\.lock\.choosing\.(\d+)\.([0-9a-f]{64})\.([0-9a-f-]+)$/
  );
  if (choosing) {
    const pid = Number(choosing[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return {
      kind: "choosing",
      pid,
      processInstance: choosing[2],
      token: choosing[3],
      path: path.join(CORTEX_DIR, name),
    };
  }

  const ticket = name.match(
    /^\.tasks\.write\.lock\.ticket\.(\d+)\.(\d+)\.([0-9a-f]{64})\.([0-9a-f-]+)$/
  );
  if (!ticket) return undefined;
  const number = Number(ticket[1]);
  const pid = Number(ticket[2]);
  if (
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    return undefined;
  }
  return {
    kind: "ticket",
    pid,
    processInstance: ticket[3],
    token: ticket[4],
    ticket: number,
    path: path.join(CORTEX_DIR, name),
  };
}

function removeTasksWriteLockRecord(recordPath: string): void {
  try {
    unlinkSync(recordPath);
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) throw error;
  }
}

function readLiveTasksWriteLockRecords(): TasksWriteLockRecord[] {
  const live: TasksWriteLockRecord[] = [];
  for (const name of readdirSync(CORTEX_DIR)) {
    const record = parseTasksWriteLockRecord(name);
    if (!record) continue;
    if (!isProcessRunning(record.pid)) {
      removeTasksWriteLockRecord(record.path);
      continue;
    }
    const processInstance = readProcessInstance(record.pid);
    if (!processInstance || processInstance === record.processInstance) {
      live.push(record);
    } else {
      // Each contender uses a unique pathname for its entire lifetime. Removing
      // a dead contender therefore cannot unlink a live replacement owner.
      removeTasksWriteLockRecord(record.path);
    }
  }
  return live;
}

function createTasksWriteLockRecord(recordPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(recordPath, "wx", 0o600);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function acquireTasksWriteLock(): Promise<() => void> {
  ensureCortexDir();
  const pid = process.pid;
  const processInstance = readProcessInstance(pid);
  if (!processInstance) {
    throw new Error("Unable to identify task write lock process instance");
  }
  const token = randomUUID();
  const choosingPath = path.join(
    CORTEX_DIR,
    `${TASKS_WRITE_LOCK_PREFIX}.choosing.${pid}.${processInstance}.${token}`
  );
  let ticketPath: string;

  // Clear dead records before entering the bakery doorway. This keeps stale
  // recovery outside the ordering protocol while every pathname remains tied
  // to exactly one contender.
  readLiveTasksWriteLockRecords();
  createTasksWriteLockRecord(choosingPath);
  try {
    const ticket =
      readLiveTasksWriteLockRecords().reduce(
        (highest, record) =>
          record.kind === "ticket" ? Math.max(highest, record.ticket) : highest,
        0
      ) + 1;
    ticketPath = path.join(
      CORTEX_DIR,
      `${TASKS_WRITE_LOCK_PREFIX}.ticket.${ticket}.${pid}.${processInstance}.${token}`
    );
    createTasksWriteLockRecord(ticketPath);
  } finally {
    removeTasksWriteLockRecord(choosingPath);
  }

  const ownTicket = parseTasksWriteLockRecord(path.basename(ticketPath));
  if (!ownTicket || ownTicket.kind !== "ticket") {
    removeTasksWriteLockRecord(ticketPath);
    throw new Error("Failed to create task write lock ticket");
  }

  while (true) {
    const records = readLiveTasksWriteLockRecords();
    const anotherContenderIsChoosing = records.some(
      (record) =>
        record.kind === "choosing" &&
        (record.pid !== ownTicket.pid || record.token !== ownTicket.token)
    );
    const earlierTicketExists = records.some((record) => {
      if (record.kind !== "ticket") return false;
      if (record.pid === ownTicket.pid && record.token === ownTicket.token) {
        return false;
      }
      if (record.ticket !== ownTicket.ticket) {
        return record.ticket < ownTicket.ticket;
      }
      if (record.pid !== ownTicket.pid) return record.pid < ownTicket.pid;
      return record.token < ownTicket.token;
    });
    if (!anotherContenderIsChoosing && !earlierTicketExists) break;
    await new Promise((resolve) => setTimeout(resolve, TASKS_WRITE_LOCK_RETRY_MS));
  }

  return () => removeTasksWriteLockRecord(ticketPath);
}

function withTasksWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  return withWriteLock(async () => {
    const release = await acquireTasksWriteLock();
    try {
      return await fn();
    } finally {
      release();
    }
  });
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
  return withTasksWriteLock(() => {
    writeTasksLocked(tasks);
  });
}

export async function getTask(id: string): Promise<Task | undefined> {
  return readTasks().find((t) => t.id === id);
}

export async function createTask(task: Task): Promise<Task> {
  return withTasksWriteLock(() => {
    const tasks = readTasks();
    tasks.push(task);
    writeTasksLocked(tasks);
    return task;
  });
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task> {
  return withTasksWriteLock(async () => {
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

export async function updateTaskAtomically(
  id: string,
  buildUpdates: (current: Task) => Partial<Task> | undefined
): Promise<Task | undefined> {
  return withTasksWriteLock(async () => {
    const tasks = readTasks();
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return undefined;

    const updates = buildUpdates(tasks[index]);
    if (!updates) return undefined;

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
  return withTasksWriteLock(() => {
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
