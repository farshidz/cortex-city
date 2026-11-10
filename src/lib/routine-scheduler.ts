import { existsSync, readdirSync, rmSync } from "fs";
import path from "path";
import { assertSufficientDiskSpace } from "./disk-guard";
import { readConfig } from "./store";
import {
  DEFAULT_ROUTINE_KEEP_RUNS,
  claimRoutineRun,
  computeNextRunAt,
  directorySize,
  listRoutines,
  listRuns,
  mutateRoutine,
  mutateRuns,
  runDataDir,
  totalRoutineStorageBytes,
} from "./routine-store";
import {
  MAX_SLACK_ATTEMPTS,
  defaultRoutineRunnerDeps,
  deliverPendingSlackMessages,
  finalizeInterruptedRun,
  finalizeRoutineRun,
  routineWorkspaceRoot,
  startRoutineRun,
  type RoutineRunnerDeps,
  type StartedRoutineRun,
} from "./routine-runner";
import type { Routine, RoutineRun } from "./types";

export const DEFAULT_MAX_PARALLEL_ROUTINES = 2;
export const DEFAULT_ROUTINE_STORAGE_LIMIT_MB = 5 * 1024;

export interface ActiveRoutineRun {
  routineId: string;
  pid?: number;
  completion: Promise<unknown>;
}

export interface RoutineSchedulerDeps {
  now: () => Date;
  startRun: (routine: Routine, run: RoutineRun) => Promise<StartedRoutineRun>;
  checkDisk: () => void;
  runner: RoutineRunnerDeps;
  log: (message: string) => void;
}

export const defaultRoutineSchedulerDeps: RoutineSchedulerDeps = {
  now: () => new Date(),
  startRun: (routine, run) => startRoutineRun(routine, run),
  checkDisk: () => assertSufficientDiskSpace("starting a routine run"),
  runner: defaultRoutineRunnerDeps,
  log: (message) => console.log(message),
};

function isActiveStatus(run: RoutineRun): boolean {
  return run.status === "queued" || run.status === "running";
}

/** Runs the worker doesn't own (it restarted) are finalized as interrupted. */
async function reconcileOrphanedRuns(
  routines: Routine[],
  active: Map<string, ActiveRoutineRun>,
  deps: RoutineSchedulerDeps
): Promise<void> {
  for (const routine of routines) {
    for (const run of listRuns(routine.id)) {
      if (!isActiveStatus(run) || active.has(run.id)) continue;
      deps.log(`[routines] Finalizing interrupted run ${run.id} of ${routine.id}`);
      if (run.pid) {
        try {
          process.kill(run.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
      await finalizeInterruptedRun(routine.id, run, deps.runner);
    }
  }
}

async function retrySlackDeliveries(routines: Routine[], deps: RoutineSchedulerDeps): Promise<void> {
  for (const routine of routines) {
    for (const run of listRuns(routine.id)) {
      if (isActiveStatus(run)) continue;
      const retry = run.slack_messages.some(
        (message) => message.status === "failed" && message.attempts < MAX_SLACK_ATTEMPTS
      ) || run.slack_messages.some((message) => message.status === "pending");
      if (retry) await deliverPendingSlackMessages(routine, run, deps.runner);
    }
  }
}

/**
 * Retention: each routine keeps its newest `keep_runs` runs plus any run
 * marked kept. When all routines together exceed the storage limit, the
 * oldest unkept finished runs go first.
 */
export async function pruneRoutineRuns(routines: Routine[], storageLimitBytes: number): Promise<number> {
  let removed = 0;
  for (const routine of routines) {
    const keep = routine.keep_runs ?? DEFAULT_ROUTINE_KEEP_RUNS;
    if (listRuns(routine.id).length <= keep) continue;
    const doomed = await mutateRuns(routine.id, (runs) => {
      const sorted = [...runs].sort((a, b) => b.number - a.number);
      const unkeptFinished = sorted.filter((run) => !run.kept && !isActiveStatus(run));
      const keptOrActive = sorted.length - unkeptFinished.length;
      const allowance = Math.max(0, keep - keptOrActive);
      const toRemove = new Set(unkeptFinished.slice(allowance).map((run) => run.id));
      return { runs: runs.filter((run) => !toRemove.has(run.id)), result: [...toRemove] };
    });
    for (const runId of doomed) {
      rmSync(runDataDir(routine.id, runId), { recursive: true, force: true });
      removed += 1;
    }
  }

  let total = totalRoutineStorageBytes();
  if (total <= storageLimitBytes) return removed;
  const candidates = routines
    .flatMap((routine) =>
      listRuns(routine.id)
        .filter((run) => !run.kept && !isActiveStatus(run))
        .map((run) => ({ routine, run }))
    )
    .sort((a, b) => (a.run.finished_at ?? a.run.created_at).localeCompare(b.run.finished_at ?? b.run.created_at));
  for (const { routine, run } of candidates) {
    if (total <= storageLimitBytes) break;
    const dir = runDataDir(routine.id, run.id);
    const size = directorySize(dir);
    rmSync(dir, { recursive: true, force: true });
    await mutateRuns(routine.id, (runs) => ({ runs: runs.filter((entry) => entry.id !== run.id), result: undefined }));
    total -= size;
    removed += 1;
  }
  return removed;
}

/** Deletes run workspaces left behind by crashes. */
export function sweepRoutineWorkspaces(active: Map<string, ActiveRoutineRun>): number {
  const root = routineWorkspaceRoot();
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || active.has(entry.name)) continue;
    rmSync(path.join(root, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

interface DueRoutine {
  routine: Routine;
  trigger: RoutineRun["trigger"];
  dueAt: string;
}

function dueRoutines(routines: Routine[], now: Date): DueRoutine[] {
  const due: DueRoutine[] = [];
  for (const routine of routines) {
    if (routine.run_requested_at) {
      due.push({ routine, trigger: "manual", dueAt: routine.run_requested_at });
    } else if (routine.enabled && routine.next_run_at && Date.parse(routine.next_run_at) <= now.getTime()) {
      due.push({ routine, trigger: "schedule", dueAt: routine.next_run_at });
    }
  }
  return due.sort((a, b) =>
    a.trigger === b.trigger ? a.dueAt.localeCompare(b.dueAt) : a.trigger === "manual" ? -1 : 1
  );
}

export async function pollRoutines(
  active: Map<string, ActiveRoutineRun>,
  deps: RoutineSchedulerDeps = defaultRoutineSchedulerDeps
): Promise<void> {
  const config = readConfig();
  let routines = listRoutines();

  await reconcileOrphanedRuns(routines, active, deps);
  await retrySlackDeliveries(routines, deps);
  await pruneRoutineRuns(
    routines,
    (config.routine_storage_limit_mb ?? DEFAULT_ROUTINE_STORAGE_LIMIT_MB) * 1024 * 1024
  );
  sweepRoutineWorkspaces(active);

  // Enabled routines always carry their next occurrence.
  for (const routine of routines) {
    if (routine.enabled && !routine.next_run_at) {
      await mutateRoutine(routine.id, (current) =>
        current.enabled && !current.next_run_at
          ? { ...current, next_run_at: computeNextRunAt(current, deps.now()) }
          : undefined
      );
    }
  }
  routines = listRoutines();

  const now = deps.now();
  const maxParallel = Math.max(1, config.max_parallel_routines ?? DEFAULT_MAX_PARALLEL_ROUTINES);
  for (const { routine, trigger } of dueRoutines(routines, now)) {
    const busy = [...active.values()].some((entry) => entry.routineId === routine.id) ||
      listRuns(routine.id).some(isActiveStatus);
    if (busy) {
      // A manual request waits for the current run; a scheduled occurrence
      // that overlaps it is skipped (recorded) and the schedule moves on.
      if (trigger === "schedule") {
        await claimRoutineRun(routine.id, "schedule", now, "skipped", "Skipped: the previous run was still going.");
        deps.log(`[routines] Skipped ${routine.id}: previous run still active`);
      }
      continue;
    }
    if (active.size >= maxParallel) break;

    const run = await claimRoutineRun(routine.id, trigger, now);
    if (!run) continue;
    try {
      deps.checkDisk();
    } catch (error) {
      await finalizeRoutineRun(routine, run, { status: "failed", error: (error as Error).message }, deps.runner);
      continue;
    }
    deps.log(`[routines] Starting run #${run.number} of "${routine.name}" (${trigger})`);
    const entry: ActiveRoutineRun = { routineId: routine.id, completion: Promise.resolve() };
    active.set(run.id, entry);
    try {
      const started = await deps.startRun(routine, run);
      entry.pid = started.pid;
      entry.completion = started.completion.finally(() => {
        active.delete(run.id);
      });
    } catch (error) {
      active.delete(run.id);
      deps.log(`[routines] Failed to start run ${run.id}: ${(error as Error).message}`);
      await finalizeRoutineRun(routine, run, { status: "failed", error: (error as Error).message }, deps.runner);
    }
  }
}

/** Stops every active run (worker shutdown). */
export function stopActiveRoutineRuns(active: Map<string, ActiveRoutineRun>): void {
  for (const entry of active.values()) {
    if (!entry.pid) continue;
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}
