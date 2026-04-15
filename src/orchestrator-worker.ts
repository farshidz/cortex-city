/**
 * Standalone orchestrator process.
 * Run separately from the Next.js server: npx tsx src/orchestrator-worker.ts
 * Reads/writes the same JSON files. No HMR, no bundling, no timer issues.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import type { Task } from "./lib/types";

const CORTEX_DIR = path.join(process.cwd(), ".cortex");
const CONFIG_FILE = path.join(CORTEX_DIR, "config.json");

function readJSON(file: string) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

function writeJSON(file: string, data: unknown) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// Import the actual logic
import { installLogger } from "./lib/logger";
installLogger();

async function poll() {
  // Fresh imports every poll to pick up any code changes
  const { readTasks, readConfig, updateTask } = await import("./lib/store");
  const { spawnAgentSession } = await import("./lib/agent-runner");
  const { getPRStateHash, getPRStatus, isPRMergedOrClosed } =
    await import("./lib/github");

  const tasks = readTasks();
  const config = readConfig();

  // Clean up orphaned PIDs
  for (const task of tasks) {
    if (!task.current_run_pid) continue;
    try {
      process.kill(task.current_run_pid, 0);
    } catch {
      console.log(`[worker] Clearing orphaned PID ${task.current_run_pid} for task ${task.id}`);
      await updateTask(task.id, { current_run_pid: undefined });
    }
  }

  // Clean up worktrees for tasks in final states
  for (const task of tasks) {
    if (
      (task.status === "merged" || task.status === "closed") &&
      task.worktree_path &&
      !activePids.has(task.id)
    ) {
      console.log(`[worker] Running cleanup for task "${task.title}" (${task.id})`);
      const { pid } = await spawnAgentSession(task, "cleanup", async (taskId: string) => {
        activePids.delete(taskId);
        const { getTask, updateTask: ut } = await import("./lib/store");
        const { removeWorktree: rw } = await import("./lib/agent-runner");
        const t = await getTask(taskId);
        if (t?.worktree_path) {
          rw(t);
          await ut(taskId, { worktree_path: undefined });
        }
      });
      activePids.set(task.id, pid);
    }
  }

  // Prune old merged/closed tasks (12+ hours old)
  const PRUNE_AGE_MS = 12 * 60 * 60 * 1000;
  const now = Date.now();
  const toPrune = tasks.filter(
    (t) =>
      (t.status === "merged" || t.status === "closed") &&
      !t.worktree_path &&
      !activePids.has(t.id) &&
      now - new Date(t.updated_at).getTime() > PRUNE_AGE_MS
  );
  if (toPrune.length > 0) {
    const { writeTasks } = await import("./lib/store");
    const remaining = tasks.filter((t) => !toPrune.some((p) => p.id === t.id));
    console.log(`[worker] Pruning ${toPrune.length} old task(s)`);
    await writeTasks(remaining);
  }

  let availableSlots = config.max_parallel_sessions - activePids.size;
  if (availableSlots <= 0) return;

  const resumableTasks = tasks
    .filter(
      (t) =>
        !activePids.has(t.id) &&
        !t.current_run_pid &&
        Boolean(t.session_id) &&
        (t.status === "open" || t.status === "in_progress")
    )
    .sort((a, b) =>
      new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    );

  for (const task of resumableTasks) {
    if (availableSlots <= 0) break;
    console.log(
      `[worker] Resuming task "${task.title}" (${task.id}) [initial]`
    );
    if (task.status === "open") {
      await updateTask(task.id, { status: "in_progress" });
    }
    const { pid } = await spawnAgentSession(task, "initial", (taskId: string) => {
      activePids.delete(taskId);
    });
    await updateTask(task.id, { current_run_pid: pid });
    activePids.set(task.id, pid);
    availableSlots--;
  }

  if (availableSlots <= 0) return;

  // Pick open tasks
  const openTasks = tasks
    .filter((t) => t.status === "open" && !t.session_id)
    .sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

  for (const task of openTasks) {
    if (availableSlots <= 0) break;
    console.log(`[worker] Picking up task "${task.title}" (${task.id}) [initial]`);
    await updateTask(task.id, { status: "in_progress" });
    const { pid } = await spawnAgentSession(task, "initial", (taskId: string) => {
      activePids.delete(taskId);
    });
    await updateTask(task.id, { current_run_pid: pid });
    activePids.set(task.id, pid);
    availableSlots--;
  }

  // Single pass over in_review tasks: check merged/closed, update status, trigger reviews
  const inReviewTasks = tasks.filter(
    (t): t is Task & { pr_url: string } => t.status === "in_review" && typeof t.pr_url === "string"
  );

  const tasksToReview: Task[] = [];

  await Promise.all(
    inReviewTasks.map(async (task) => {
      try {
        // Check merged/closed first (1 API call)
        const prState = await isPRMergedOrClosed(task.pr_url);
        if (prState) {
          console.log(`[worker] PR ${prState} for "${task.title}"`);
          await updateTask(task.id, { status: prState, pr_status: undefined });
          return;
        }

        // Check PR status + pending checks + hash in one batch
        // getPRStatus already fetches checks and mergeable state
        const prStatus = await getPRStatus(task.pr_url);
        if (prStatus !== "unknown" && prStatus !== task.pr_status) {
          await updateTask(task.id, { pr_status: prStatus });
          task.pr_status = prStatus;
        }

        // Skip if checks pending, active session, or no PR
        if (prStatus === "checks_pending") return;
        if (activePids.has(task.id)) return;

        const ghState = await getPRStateHash(task.pr_url);
        if (!ghState) return; // API failed — skip

        const hasConflicts = prStatus === "conflicts";
        if (!hasConflicts && ghState === task.last_review_gh_state) return;

        tasksToReview.push(task);
      } catch (err) {
        console.error(`[worker] PR check failed for ${task.id}:`, err);
      }
    })
  );

  // Sequential spawn for tasks that need review
  for (const task of tasksToReview) {
    if (availableSlots <= 0) break;
    console.log(`[worker] Picking up task "${task.title}" (${task.id}) [review]`);
    const { pid } = await spawnAgentSession(task, "review", (taskId: string) => {
      activePids.delete(taskId);
    });
    await updateTask(task.id, { current_run_pid: pid });
    activePids.set(task.id, pid);
    availableSlots--;
  }
}

// Track active sessions
const activePids = new Map<string, number>();
const STATE_FILE = path.join(CORTEX_DIR, "orchestrator-state.json");
let pollInFlight: Promise<void> | null = null;

function writeState(lastPollAt: string | null) {
  writeJSON(STATE_FILE, {
    running: true,
    active_sessions: activePids.size,
    last_poll_at: lastPollAt,
    pid: process.pid,
  });
}

async function runPollCycle() {
  if (pollInFlight) return pollInFlight;
  pollInFlight = (async () => {
    const pollTime = new Date().toISOString();
    try {
      await poll();
    } catch (err) {
      console.error("[worker] Poll error:", err);
    }
    writeState(pollTime);
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
  writeState(null);

  while (true) {
    await runPollCycle();
    await new Promise((r) => setTimeout(r, interval));
  }
}

process.on("SIGUSR1", () => {
  console.log("[worker] Immediate poll requested");
  void runPollCycle();
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("[worker] Shutting down...");
  for (const [, pid] of activePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  writeJSON(STATE_FILE, {
    running: false,
    active_sessions: 0,
    last_poll_at: null,
    pid: process.pid,
  });
  process.exit(0);
});
process.on("SIGTERM", () => process.exit(0));

main();
