import { readFileSync, existsSync } from "fs";
import path from "path";
import type { ActiveSession, OrchestratorStatus } from "./types";

// The orchestrator now runs as a separate process (orchestrator-worker.ts).
// This module just reads status for the API.

const STATE_FILE = path.join(process.cwd(), ".cortex", "orchestrator-state.json");

interface WorkerState {
  running: boolean;
  active_sessions: number;
  last_poll_at: string | null;
}

function readWorkerState(): WorkerState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return { running: false, active_sessions: 0, last_poll_at: null };
}

export function getOrchestrator() {
  return {
    getStatus(): OrchestratorStatus {
      const { readConfig } = require("./store");
      const config = readConfig();
      const state = readWorkerState();
      return {
        running: state.running,
        active_sessions: state.active_sessions,
        max_sessions: config.max_parallel_sessions,
        last_poll_at: state.last_poll_at,
      };
    },

    getActiveSessions(): ActiveSession[] {
      // Active sessions are tracked by PIDs in tasks.json
      const { readTasks } = require("./store");
      const tasks = readTasks();
      return tasks
        .filter((t: any) => t.current_run_pid)
        .map((t: any) => ({
          task_id: t.id,
          task_title: t.title,
          agent: t.agent,
          session_id: t.session_id || "unknown",
          pid: t.current_run_pid,
          started_at: t.last_run_at || t.updated_at,
          status: "running" as const,
        }));
    },

    killSession(taskId: string): boolean {
      const { readTasks, updateTask } = require("./store");
      const tasks = readTasks();
      const task = tasks.find((t: any) => t.id === taskId);
      if (!task?.current_run_pid) return false;
      try {
        process.kill(task.current_run_pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(task.current_run_pid, "SIGKILL");
          } catch {}
        }, 5000);
        updateTask(taskId, { current_run_pid: undefined });
        return true;
      } catch {
        updateTask(taskId, { current_run_pid: undefined });
        return false;
      }
    },

    pollNow() {
      // Worker polls on its own schedule — this is a no-op now
      console.log("[orchestrator] pollNow called — worker polls independently");
    },
  };
}
