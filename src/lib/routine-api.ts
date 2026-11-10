import { NextResponse } from "next/server";
import { listSecrets, SecretValidationError } from "./secret-store";
import {
  RoutineValidationError,
  getRoutine,
  isValidRoutineId,
  isValidRunId,
  listRoutines,
  listRuns,
  nextRunTimes,
  routineStorageBytes,
} from "./routine-store";
import { SlackError } from "./slack";
import type { Routine, RoutineRun } from "./types";

export interface RoutineSummary extends Routine {
  last_run?: Pick<RoutineRun, "id" | "number" | "status" | "created_at" | "started_at" | "finished_at" | "trigger">;
  active_run_id?: string;
  storage_bytes: number;
}

export function summarizeRoutine(routine: Routine): RoutineSummary {
  const runs = listRuns(routine.id);
  const active = runs.find((run) => run.status === "queued" || run.status === "running");
  const last = runs.find((run) => run.status !== "skipped") ?? runs[0];
  return {
    ...routine,
    ...(last
      ? {
          last_run: {
            id: last.id,
            number: last.number,
            status: last.status,
            trigger: last.trigger,
            created_at: last.created_at,
            ...(last.started_at ? { started_at: last.started_at } : {}),
            ...(last.finished_at ? { finished_at: last.finished_at } : {}),
          },
        }
      : {}),
    ...(active ? { active_run_id: active.id } : {}),
    storage_bytes: routineStorageBytes(routine.id),
  };
}

export function routineDetail(routine: Routine) {
  let next_runs: string[] = [];
  if (routine.enabled) {
    try {
      next_runs = nextRunTimes(routine.cron, routine.timezone, new Date(), 4).map((date) => date.toISOString());
    } catch {
      next_runs = [];
    }
  }
  return {
    routine: summarizeRoutine(routine),
    runs: listRuns(routine.id),
    secrets: listSecrets({ kind: "routine", routineId: routine.id }),
    next_runs,
  };
}

/** Which routines tick each global secret. */
export function globalSecretUsage(): Record<string, { id: string; name: string; overridden: boolean }[]> {
  const usage: Record<string, { id: string; name: string; overridden: boolean }[]> = {};
  for (const routine of listRoutines()) {
    const own = new Set(listSecrets({ kind: "routine", routineId: routine.id }).map((secret) => secret.name));
    for (const name of routine.global_secrets) {
      (usage[name] ??= []).push({ id: routine.id, name: routine.name, overridden: own.has(name) });
    }
  }
  return usage;
}

export function findRoutine(id: string): Routine | undefined {
  return isValidRoutineId(id) ? getRoutine(id) : undefined;
}

export function findRun(routineId: string, runId: string): { routine: Routine; run: RoutineRun } | undefined {
  const routine = findRoutine(routineId);
  if (!routine || !isValidRunId(runId)) return undefined;
  const run = listRuns(routine.id).find((entry) => entry.id === runId);
  return run ? { routine, run } : undefined;
}

export function notFound(what = "Not found") {
  return NextResponse.json({ error: what }, { status: 404 });
}

/** Maps validation errors to 400s; anything else is rethrown. */
export function validationErrorResponse(error: unknown) {
  if (
    error instanceof RoutineValidationError ||
    error instanceof SecretValidationError ||
    error instanceof SlackError
  ) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  throw error;
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// Agent-written files are untrusted. Served with an opaque-origin sandbox and
// no network access at all: a report's inline scripts can draw charts, but it
// cannot reach Cortex City's API, load remote resources or send data anywhere.
export const ARTIFACT_CSP = [
  "sandbox allow-scripts allow-popups",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");
