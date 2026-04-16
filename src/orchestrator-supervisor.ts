import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { installLogger } from "./lib/logger";

installLogger();

const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
const workerEntry = path.join(process.cwd(), "src", "orchestrator-worker.ts");
const CORTEX_DIR = path.join(process.cwd(), ".cortex");
const STATE_FILE = path.join(CORTEX_DIR, "orchestrator-state.json");
const SUPERVISOR_PID_FILE = path.join(CORTEX_DIR, "orchestrator-supervisor.pid");

let child: ChildProcess | null = null;
let shuttingDown = false;
let watchdog: NodeJS.Timeout | null = null;

function isPidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readExistingWorkerPid(): number | undefined {
  try {
    if (!existsSync(STATE_FILE)) return undefined;
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { pid?: number };
    return state.pid;
  } catch {
    return undefined;
  }
}

function writeSupervisorPidFile() {
  mkdirSync(CORTEX_DIR, { recursive: true });
  writeFileSync(SUPERVISOR_PID_FILE, `${process.pid}\n`, "utf-8");
}

function removeSupervisorPidFile() {
  try {
    if (!existsSync(SUPERVISOR_PID_FILE)) return;
    const current = readFileSync(SUPERVISOR_PID_FILE, "utf-8").trim();
    if (current === String(process.pid)) {
      rmSync(SUPERVISOR_PID_FILE, { force: true });
    }
  } catch {
    // Best effort cleanup.
  }
}

function startWorker() {
  console.log("[supervisor] Starting orchestrator worker");
  child = spawn(tsxBin, [workerEntry], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    console.log(
      `[supervisor] Worker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`
    );
    child = null;
    if (shuttingDown) {
      removeSupervisorPidFile();
      process.exit(code ?? 0);
      return;
    }
    setTimeout(() => {
      if (!shuttingDown) startWorker();
    }, 2000);
  });
}

function ensureWorker() {
  if (child) return;
  const pid = readExistingWorkerPid();
  if (isPidAlive(pid)) return;
  startWorker();
}

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[supervisor] Shutting down on ${signal}`);
  if (watchdog) clearInterval(watchdog);
  removeSupervisorPidFile();
  if (child?.pid) {
    try {
      process.kill(child.pid, signal);
      return;
    } catch {}
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => {
  // Keep the supervisor alive if the launching terminal disappears.
});
process.on("exit", removeSupervisorPidFile);

writeSupervisorPidFile();
ensureWorker();
watchdog = setInterval(() => {
  if (!shuttingDown) ensureWorker();
}, 2000);
