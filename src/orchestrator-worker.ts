/**
 * Standalone orchestrator process.
 * Run separately from the Next.js server: npx tsx src/orchestrator-worker.ts
 * Reads/writes the same JSON files. No HMR, no bundling, no timer issues.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { pollOnce } from "./lib/orchestrator-worker-runtime";

const CORTEX_DIR = path.join(process.cwd(), ".cortex");
const CONFIG_FILE = path.join(CORTEX_DIR, "config.json");

function readJSON(file: string) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

function writeJSON(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// Import the actual logic
import { installLogger } from "./lib/logger";
installLogger();

// Track active sessions
const activePids = new Map<string, number>();
const STATE_FILE = path.join(CORTEX_DIR, "orchestrator-state.json");
let pollInFlight: Promise<void> | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
const startedAt = new Date().toISOString();
let lastPollAt: string | null = null;
let pollStartedAt: string | null = null;
let pollFinishedAt: string | null = null;
let pollInProgress = false;
let shuttingDown = false;

function writeState() {
  writeJSON(STATE_FILE, {
    running: true,
    active_sessions: activePids.size,
    last_poll_at: lastPollAt,
    last_heartbeat_at: new Date().toISOString(),
    started_at: startedAt,
    poll_started_at: pollStartedAt,
    poll_finished_at: pollFinishedAt,
    poll_in_progress: pollInProgress,
    pid: process.pid,
  });
}

async function runPollCycle() {
  if (pollInFlight) return pollInFlight;
  pollInFlight = (async () => {
    const pollTime = new Date().toISOString();
    pollStartedAt = pollTime;
    pollInProgress = true;
    writeState();
    console.log(`[worker] Poll started at ${pollTime}`);
    try {
      await pollOnce(activePids);
    } catch (err) {
      console.error("[worker] Poll error:", err);
    }
    lastPollAt = pollTime;
    pollFinishedAt = new Date().toISOString();
    pollInProgress = false;
    writeState();
    console.log(`[worker] Poll finished at ${pollFinishedAt}`);
  })();
  try {
    await pollInFlight;
  } finally {
    pollInFlight = null;
  }
}

// Main loop
async function main() {
  const config = readJSON(CONFIG_FILE) || { poll_interval_seconds: 10 };
  const interval = config.poll_interval_seconds * 1000;
  console.log(`[worker] Orchestrator started. Polling every ${config.poll_interval_seconds}s`);
  writeState();
  heartbeatTimer = setInterval(() => writeState(), 5000);

  while (true) {
    await runPollCycle();
    await new Promise((r) => setTimeout(r, interval));
  }
}

process.on("SIGUSR1", () => {
  console.log("[worker] Immediate poll requested");
  void runPollCycle();
});

function shutdown(signal: NodeJS.Signals, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] Shutting down on ${signal}...`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const [, pid] of activePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  writeJSON(STATE_FILE, {
    running: false,
    active_sessions: 0,
    last_poll_at: lastPollAt,
    last_heartbeat_at: new Date().toISOString(),
    started_at: startedAt,
    poll_started_at: pollStartedAt,
    poll_finished_at: pollFinishedAt,
    poll_in_progress: false,
    pid: process.pid,
  });
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  console.error("[worker] Fatal error:", error);
  shutdown("SIGTERM", 1);
});
