import { readFileSync, existsSync } from "fs";
import path from "path";
import type { ActiveSession, OrchestratorStatus, Task } from "./types";
import { readConfig, readTasks, updateTask } from "./store";

// The orchestrator now runs as a separate process (orchestrator-worker.ts).
// This module just reads status for the API.

const STATE_FILE = path.join(process.cwd(), ".cortex", "orchestrator-state.json");

interface WorkerState {
  running: boolean;
  active_sessions: number;
  last_poll_at: string | null;
  last_heartbeat_at: string | null;
  started_at: string | null;
  poll_started_at: string | null;
  poll_finished_at: string | null;
  poll_in_progress: boolean;
  pid?: number;
}

function isPidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readWorkerState(): WorkerState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return {
    running: false,
    active_sessions: 0,
    last_poll_at: null,
    last_heartbeat_at: null,
    started_at: null,
    poll_started_at: null,
    poll_finished_at: null,
    poll_in_progress: false,
  };
}

function hasActivePid(task: Task): task is Task & { current_run_pid: number } {
  return typeof task.current_run_pid === "number";
}

export function getOrchestrator() {
  return {
    getStatus(): OrchestratorStatus {
      const config = readConfig();
      const state = readWorkerState();
      const healthy = isPidAlive(state.pid);
      return {
        running: state.running && healthy,
        healthy,
        active_sessions: state.active_sessions,
        max_sessions: config.max_parallel_sessions,
        last_poll_at: state.last_poll_at,
        last_heartbeat_at: state.last_heartbeat_at,
        started_at: state.started_at,
        poll_started_at: state.poll_started_at,
        poll_finished_at: state.poll_finished_at,
        poll_in_progress: healthy ? state.poll_in_progress : false,
      };
    },

    getActiveSessions(): ActiveSession[] {
      // Active sessions are tracked by PIDs in tasks.json
      const tasks = readTasks();
      return tasks
        .filter(hasActivePid)
        .map((t) => ({
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
      const tasks = readTasks();
      const task = tasks.find((t) => t.id === taskId);
      const pid = task?.current_run_pid;
      if (!pid) return false;
      const updates: Partial<Task> = {
        current_run_pid: undefined,
        resume_requested: true,
      };
      try {
        process.kill(pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }, 5000);
        updateTask(taskId, updates);
        return true;
      } catch {
        updateTask(taskId, updates);
        return false;
      }
    },
    requestPoll(): boolean {
      const state = readWorkerState();
      const pid = state.pid;
      if (!state.running || pid === undefined || !isPidAlive(pid)) return false;
      try {
        process.kill(pid, "SIGUSR1");
        return true;
      } catch {
        return false;
      }
    },
  };
}
