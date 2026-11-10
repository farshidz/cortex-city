import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import * as lockfile from "proper-lockfile";
import { CronExpressionParser } from "cron-parser";
import { snapshotCortex } from "./cortex-git";
import { ensureCortexDir } from "./store";
import { deleteSecretScope } from "./secret-store";
import type {
  AgentRuntime,
  Routine,
  RoutineRun,
  RoutineSlackConfig,
  TaskEffort,
} from "./types";

export const DEFAULT_ROUTINE_TIMEOUT_MINUTES = 30;
export const MAX_ROUTINE_TIMEOUT_MINUTES = 24 * 60;
export const DEFAULT_ROUTINE_KEEP_RUNS = 30;
export const MAX_ROUTINE_KEEP_RUNS = 1000;
export const DEFAULT_ROUTINE_MAX_RUN_MB = 100;
// Keeps every file under Node's 2 GB read limit and the zip under 4 GB.
export const MAX_ROUTINE_MAX_RUN_MB = 1000;
export const DEFAULT_ROUTINE_TIMEZONE = "UTC";

const ROUTINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function cortexDir(): string {
  ensureCortexDir();
  return path.join(/* turbopackIgnore: true */ process.cwd(), ".cortex");
}

function routinesFile(): string {
  return path.join(cortexDir(), "routines.json");
}

function runsFile(routineId: string): string {
  assertRoutineId(routineId);
  return path.join(cortexDir(), "routine-runs", `${routineId}.json`);
}

export function routineDataDir(routineId: string): string {
  assertRoutineId(routineId);
  return path.join(cortexDir(), "routine-data", routineId);
}

export function runDataDir(routineId: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid run id");
  return path.join(routineDataDir(routineId), runId);
}

export function runArtifactsDir(routineId: string, runId: string): string {
  return path.join(runDataDir(routineId, runId), "artifacts");
}

export function runTranscriptPath(routineId: string, runId: string): string {
  return path.join(runDataDir(routineId, runId), "transcript.log");
}

function assertRoutineId(routineId: string): void {
  if (!ROUTINE_ID_PATTERN.test(routineId)) throw new Error("Invalid routine id");
}

export function isValidRoutineId(id: string): boolean {
  return ROUTINE_ID_PATTERN.test(id);
}

export function isValidRunId(id: string): boolean {
  return RUN_ID_PATTERN.test(id);
}

// --- Locking ---

let inProcessLock: Promise<unknown> = Promise.resolve();

async function withRoutineLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = inProcessLock.then(async () => {
    const target = path.join(cortexDir(), ".routines.lock");
    const release = await lockfile.lock(target, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 400, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  });
  inProcessLock = run.catch(() => undefined);
  return run;
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function readJsonArray<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// --- Schedules ---

export function validateCron(cron: string): string | undefined {
  const trimmed = cron.trim();
  if (trimmed.split(/\s+/).length !== 5) {
    return "Use a 5-field cron expression: minute hour day-of-month month day-of-week.";
  }
  try {
    CronExpressionParser.parse(trimmed, { tz: "UTC" });
    return undefined;
  } catch (error) {
    return `Invalid cron expression: ${(error as Error).message}`;
  }
}

export function validateTimezone(timezone: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return undefined;
  } catch {
    return `Unknown timezone: ${timezone}`;
  }
}

export function nextRunTimes(
  cron: string,
  timezone: string,
  from: Date = new Date(),
  count = 1
): Date[] {
  const iterator = CronExpressionParser.parse(cron.trim(), {
    currentDate: from,
    tz: timezone,
  });
  const result: Date[] = [];
  for (let i = 0; i < count; i += 1) {
    result.push(iterator.next().toDate());
  }
  return result;
}

export function computeNextRunAt(routine: Pick<Routine, "cron" | "timezone">, from = new Date()): string {
  return nextRunTimes(routine.cron, routine.timezone, from, 1)[0].toISOString();
}

// --- Normalization & validation ---

export class RoutineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineValidationError";
  }
}

export interface RoutineInput {
  name?: unknown;
  prompt?: unknown;
  cron?: unknown;
  timezone?: unknown;
  enabled?: unknown;
  agent_runner?: unknown;
  model?: unknown;
  effort?: unknown;
  timeout_minutes?: unknown;
  global_secrets?: unknown;
  slack?: unknown;
  keep_runs?: unknown;
  max_run_mb?: unknown;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function boundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new RoutineValidationError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function normalizeChannel(channel: string): string {
  const trimmed = channel.trim();
  if (/^[CG][A-Z0-9]{6,}$/.test(trimmed)) return trimmed;
  return trimmed.replace(/^#/, "").toLowerCase();
}

function normalizeSlack(value: unknown): RoutineSlackConfig {
  if (value === undefined || value === null) return { allowed_channels: [] };
  if (typeof value !== "object") throw new RoutineValidationError("slack must be an object");
  const raw = value as Record<string, unknown>;
  const channels = raw.allowed_channels ?? [];
  if (!Array.isArray(channels) || channels.some((c) => typeof c !== "string")) {
    throw new RoutineValidationError("slack.allowed_channels must be an array of channel names");
  }
  const allowed = [...new Set(channels.map((c: string) => normalizeChannel(c)).filter(Boolean))];
  const failure =
    typeof raw.failure_channel === "string" && raw.failure_channel.trim()
      ? normalizeChannel(raw.failure_channel)
      : undefined;
  return { allowed_channels: allowed, ...(failure ? { failure_channel: failure } : {}) };
}

/**
 * Applies `input` on top of `base` (a full routine for updates, defaults for
 * creates). Only fields present in the input change.
 */
export function applyRoutineInput(base: Routine, input: RoutineInput): Routine {
  const has = (key: keyof RoutineInput) => Object.prototype.hasOwnProperty.call(input, key);
  const next: Routine = { ...base, slack: { ...base.slack } };

  if (has("name")) {
    const name = optionalString(input.name);
    if (!name) throw new RoutineValidationError("name is required");
    if (name.length > 200) throw new RoutineValidationError("name is limited to 200 characters");
    next.name = name;
  }
  if (has("prompt")) {
    if (typeof input.prompt !== "string" || !input.prompt.trim()) {
      throw new RoutineValidationError("prompt is required");
    }
    next.prompt = input.prompt;
  }
  if (has("cron")) {
    const cron = typeof input.cron === "string" ? input.cron.trim().replace(/\s+/g, " ") : "";
    const error = validateCron(cron);
    if (error) throw new RoutineValidationError(error);
    next.cron = cron;
  }
  if (has("timezone")) {
    const timezone = optionalString(input.timezone) ?? DEFAULT_ROUTINE_TIMEZONE;
    const error = validateTimezone(timezone);
    if (error) throw new RoutineValidationError(error);
    next.timezone = timezone;
  }
  if (has("enabled")) {
    if (typeof input.enabled !== "boolean") throw new RoutineValidationError("enabled must be a boolean");
    next.enabled = input.enabled;
  }
  if (has("agent_runner")) {
    const runtime = optionalString(input.agent_runner);
    if (runtime && runtime !== "claude" && runtime !== "codex") {
      throw new RoutineValidationError("agent_runner must be \"claude\" or \"codex\"");
    }
    if (runtime) next.agent_runner = runtime as AgentRuntime;
    else delete next.agent_runner;
  }
  if (has("model")) {
    const model = optionalString(input.model);
    if (model) next.model = model;
    else delete next.model;
  }
  if (has("effort")) {
    const effort = optionalString(input.effort);
    if (effort) next.effort = effort as TaskEffort;
    else delete next.effort;
  }
  if (has("timeout_minutes")) {
    const value = boundedInteger(input.timeout_minutes, "timeout_minutes", 1, MAX_ROUTINE_TIMEOUT_MINUTES);
    if (value === undefined) delete next.timeout_minutes;
    else next.timeout_minutes = value;
  }
  if (has("keep_runs")) {
    const value = boundedInteger(input.keep_runs, "keep_runs", 1, MAX_ROUTINE_KEEP_RUNS);
    if (value === undefined) delete next.keep_runs;
    else next.keep_runs = value;
  }
  if (has("max_run_mb")) {
    const value = boundedInteger(input.max_run_mb, "max_run_mb", 1, MAX_ROUTINE_MAX_RUN_MB);
    if (value === undefined) delete next.max_run_mb;
    else next.max_run_mb = value;
  }
  if (has("global_secrets")) {
    const value = input.global_secrets ?? [];
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
      throw new RoutineValidationError("global_secrets must be an array of secret names");
    }
    next.global_secrets = [...new Set(value.map((name: string) => name.trim()).filter(Boolean))];
  }
  if (has("slack")) {
    next.slack = normalizeSlack(input.slack);
  }
  return next;
}

function normalizeStoredRoutine(raw: Partial<Routine>): Routine {
  return {
    id: raw.id ?? nanoid(10),
    name: raw.name ?? "Untitled routine",
    prompt: raw.prompt ?? "",
    cron: raw.cron ?? "0 9 * * 1",
    timezone: raw.timezone ?? DEFAULT_ROUTINE_TIMEZONE,
    enabled: raw.enabled ?? false,
    ...(raw.agent_runner ? { agent_runner: raw.agent_runner } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    ...(raw.effort ? { effort: raw.effort } : {}),
    ...(raw.timeout_minutes ? { timeout_minutes: raw.timeout_minutes } : {}),
    global_secrets: Array.isArray(raw.global_secrets) ? raw.global_secrets : [],
    slack: {
      allowed_channels: Array.isArray(raw.slack?.allowed_channels) ? raw.slack!.allowed_channels : [],
      ...(raw.slack?.failure_channel ? { failure_channel: raw.slack.failure_channel } : {}),
    },
    ...(raw.keep_runs ? { keep_runs: raw.keep_runs } : {}),
    ...(raw.max_run_mb ? { max_run_mb: raw.max_run_mb } : {}),
    ...(raw.next_run_at ? { next_run_at: raw.next_run_at } : {}),
    ...(raw.run_requested_at ? { run_requested_at: raw.run_requested_at } : {}),
    ...(raw.last_run_number ? { last_run_number: raw.last_run_number } : {}),
    created_at: raw.created_at ?? new Date().toISOString(),
    updated_at: raw.updated_at ?? new Date().toISOString(),
  };
}

// --- Routines CRUD ---

export function listRoutines(): Routine[] {
  return readJsonArray<Partial<Routine>>(routinesFile()).map(normalizeStoredRoutine);
}

export function getRoutine(id: string): Routine | undefined {
  return listRoutines().find((routine) => routine.id === id);
}

function writeRoutinesLocked(routines: Routine[], snapshotReason?: string): void {
  writeJsonAtomic(routinesFile(), routines);
  if (snapshotReason) snapshotCortex(snapshotReason);
}

function scheduleFields(routine: Routine, previous?: Routine): Routine {
  const scheduleChanged =
    !previous ||
    previous.cron !== routine.cron ||
    previous.timezone !== routine.timezone ||
    previous.enabled !== routine.enabled;
  if (!routine.enabled) {
    const { next_run_at: _ignored, ...rest } = routine;
    void _ignored;
    return rest;
  }
  if (scheduleChanged || !routine.next_run_at) {
    return { ...routine, next_run_at: computeNextRunAt(routine) };
  }
  return routine;
}

export async function createRoutine(input: RoutineInput): Promise<Routine> {
  const now = new Date().toISOString();
  const base: Routine = {
    id: nanoid(10),
    name: "",
    prompt: "",
    cron: "",
    timezone: DEFAULT_ROUTINE_TIMEZONE,
    enabled: true,
    global_secrets: [],
    slack: { allowed_channels: [] },
    created_at: now,
    updated_at: now,
  };
  const withDefaults: RoutineInput = {
    timezone: DEFAULT_ROUTINE_TIMEZONE,
    ...input,
    name: input.name ?? "",
    prompt: input.prompt ?? "",
    cron: input.cron ?? "",
  };
  const routine = scheduleFields(applyRoutineInput(base, withDefaults));
  return withRoutineLock(() => {
    const routines = listRoutines();
    routines.push(routine);
    writeRoutinesLocked(routines, "routines");
    return routine;
  });
}

export async function updateRoutine(id: string, input: RoutineInput): Promise<Routine | undefined> {
  return withRoutineLock(() => {
    const routines = listRoutines();
    const index = routines.findIndex((routine) => routine.id === id);
    if (index === -1) return undefined;
    const previous = routines[index];
    const next = scheduleFields(
      { ...applyRoutineInput(previous, input), updated_at: new Date().toISOString() },
      previous
    );
    routines[index] = next;
    writeRoutinesLocked(routines, "routines");
    return next;
  });
}

/**
 * Worker-owned field updates (next_run_at, run_requested_at, run numbers).
 * The mutator runs under the store lock and may return undefined to skip.
 */
export async function mutateRoutine(
  id: string,
  mutate: (routine: Routine) => Routine | undefined
): Promise<Routine | undefined> {
  return withRoutineLock(() => {
    const routines = listRoutines();
    const index = routines.findIndex((routine) => routine.id === id);
    if (index === -1) return undefined;
    const next = mutate(routines[index]);
    if (!next) return undefined;
    routines[index] = next;
    writeRoutinesLocked(routines);
    return next;
  });
}

export async function requestRoutineRun(id: string): Promise<Routine | undefined> {
  return mutateRoutine(id, (routine) => ({
    ...routine,
    run_requested_at: new Date().toISOString(),
  }));
}

export type DeleteRoutineResult = "deleted" | "not_found" | "active";

/** Refuses (under the lock the worker claims runs with) while a run is active. */
export async function deleteRoutine(id: string): Promise<DeleteRoutineResult> {
  const result = await withRoutineLock((): DeleteRoutineResult => {
    const routines = listRoutines();
    const filtered = routines.filter((routine) => routine.id !== id);
    if (filtered.length === routines.length) return "not_found";
    if (hasActiveRun(id)) return "active";
    writeRoutinesLocked(filtered, "routines");
    rmSync(runsFile(id), { force: true });
    rmSync(routineDataDir(id), { recursive: true, force: true });
    return "deleted";
  });
  if (result === "deleted") await deleteSecretScope({ kind: "routine", routineId: id });
  return result;
}

// --- Runs ---

export function listRuns(routineId: string): RoutineRun[] {
  return readJsonArray<RoutineRun>(runsFile(routineId)).sort((a, b) => b.number - a.number);
}

export function getRun(routineId: string, runId: string): RoutineRun | undefined {
  return listRuns(routineId).find((run) => run.id === runId);
}

export function hasActiveRun(routineId: string): boolean {
  return listRuns(routineId).some((run) => run.status === "queued" || run.status === "running");
}

export async function mutateRuns<T>(
  routineId: string,
  mutate: (runs: RoutineRun[]) => { runs: RoutineRun[]; result: T }
): Promise<T> {
  return withRoutineLock(() => {
    const { runs, result } = mutate(listRuns(routineId));
    writeJsonAtomic(runsFile(routineId), runs);
    return result;
  });
}

export async function updateRun(
  routineId: string,
  runId: string,
  update: Partial<RoutineRun> | ((run: RoutineRun) => Partial<RoutineRun>)
): Promise<RoutineRun | undefined> {
  return mutateRuns(routineId, (runs) => {
    const index = runs.findIndex((run) => run.id === runId);
    if (index === -1) return { runs, result: undefined };
    const changes = typeof update === "function" ? update(runs[index]) : update;
    runs[index] = { ...runs[index], ...changes };
    return { runs, result: runs[index] };
  });
}

/**
 * Claims the next run slot for a routine: records a queued run, numbers it,
 * clears a pending manual request and advances next_run_at, all under one
 * lock so a crash cannot fire the same occurrence twice.
 */
export async function claimRoutineRun(
  routineId: string,
  trigger: RoutineRun["trigger"],
  now = new Date(),
  status: "queued" | "skipped" = "queued",
  error?: string
): Promise<RoutineRun | undefined> {
  return withRoutineLock(() => {
    const routines = listRoutines();
    const index = routines.findIndex((routine) => routine.id === routineId);
    if (index === -1) return undefined;
    const routine = routines[index];
    const number = (routine.last_run_number ?? 0) + 1;
    const run: RoutineRun = {
      id: nanoid(12),
      routine_id: routineId,
      number,
      trigger,
      status,
      ...(trigger === "schedule" && routine.next_run_at ? { scheduled_for: routine.next_run_at } : {}),
      created_at: now.toISOString(),
      ...(status === "skipped" ? { finished_at: now.toISOString() } : {}),
      artifacts: [],
      artifacts_bytes: 0,
      slack_messages: [],
      secrets_used: [],
      ...(error ? { error } : {}),
    };
    const updated: Routine = { ...routine, last_run_number: number };
    if (trigger === "manual") delete updated.run_requested_at;
    if (trigger === "schedule") {
      if (routine.enabled) updated.next_run_at = computeNextRunAt(routine, now);
      else delete updated.next_run_at;
    }
    routines[index] = updated;
    writeRoutinesLocked(routines);
    const runs = listRuns(routineId);
    runs.push(run);
    writeJsonAtomic(runsFile(routineId), runs);
    return run;
  });
}

// --- Storage accounting ---

export function directorySize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          // Removed while scanning.
        }
      }
    }
  }
  return total;
}

export function routineStorageBytes(routineId: string): number {
  return directorySize(routineDataDir(routineId));
}

export function totalRoutineStorageBytes(): number {
  return directorySize(path.join(cortexDir(), "routine-data"));
}
