import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  type WriteStream,
} from "fs";
import path from "path";

const LOGS_DIR = path.join(process.cwd(), "logs");
const MAX_AGE_DAYS = 14;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureLogsDir() {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function timestamp(): string {
  return new Date().toISOString();
}

// --- Server log (daily rotation) ---

let currentDate = "";
let serverLogPath = "";

function getServerLogPath(): string {
  const today = todayStr();
  if (today !== currentDate) {
    currentDate = today;
    ensureLogsDir();
    serverLogPath = path.join(LOGS_DIR, `server-${today}.log`);
    cleanOldLogs();
  }
  return serverLogPath;
}

function cleanOldLogs() {
  try {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const files = readdirSync(LOGS_DIR);
    for (const file of files) {
      if (!file.startsWith("server-") || !file.endsWith(".log")) continue;
      // Parse date from filename: server-YYYY-MM-DD.log
      const dateStr = file.slice(7, 17);
      const fileDate = new Date(dateStr).getTime();
      if (fileDate && fileDate < cutoff) {
        unlinkSync(path.join(LOGS_DIR, file));
      }
    }
  } catch {
    // Best effort cleanup
  }
}

function writeServerLog(level: string, ...args: unknown[]) {
  const logPath = getServerLogPath();
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const line = `${timestamp()} [${level}] ${msg}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    // Don't throw if logging fails
  }
}

// --- Intercept console ---

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

let installed = false;

export function installLogger() {
  if (installed) return;
  installed = true;

  console.log = (...args: unknown[]) => {
    originalLog(...args);
    writeServerLog("INFO", ...args);
  };

  console.error = (...args: unknown[]) => {
    originalError(...args);
    writeServerLog("ERROR", ...args);
  };

  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    writeServerLog("WARN", ...args);
  };

  console.log("[logger] Server logging to", getServerLogPath());
}

// --- Session log (real-time streaming) ---

export function createSessionLog(taskId: string): {
  machine: WriteStream;
  transcript: WriteStream;
  machinePath: string;
  transcriptPath: string;
} {
  ensureLogsDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const machinePath = path.join(LOGS_DIR, `task-${taskId}-${ts}.jsonl`);
  const transcriptPath = path.join(LOGS_DIR, `task-${taskId}-${ts}.log`);

  const machine = createWriteStream(machinePath, { flags: "a" });
  const transcript = createWriteStream(transcriptPath, { flags: "a" });
  const header = `--- Session started at ${timestamp()} ---\n\n`;

  machine.write(header);
  transcript.write(header);

  return { machine, transcript, machinePath, transcriptPath };
}

export function deleteTaskLogs(taskId: string): void {
  if (!existsSync(LOGS_DIR)) return;

  const pattern = new RegExp(`^task-${escapeRegex(taskId)}-.*\\.(jsonl|log)$`);
  try {
    for (const file of readdirSync(LOGS_DIR)) {
      if (!pattern.test(file)) continue;
      unlinkSync(path.join(LOGS_DIR, file));
    }
  } catch {
    // Best effort cleanup
  }
}
